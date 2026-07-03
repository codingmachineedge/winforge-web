import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runCommand, runPowershell, type CommandOutput } from '../tauri/bridge';
import { ModuleToolbar, StatusDot, useAsync } from './common';

// ============================================================================
// Blender (3D / Render) — module.blender — native web port of WinForge's
// BlenderModule (BlenderModule.xaml.cs + Services/BlenderService.cs +
// Catalog/BlenderOperations.cs).
//
// WinForge is the launcher, headless render-job builder and progress dashboard
// around the installed blender.exe — it never links Blender's code. Ported here
// against the Tauri backend:
//   • detect blender.exe (PATH → winget Links → Program Files) + read --version
//   • quick actions: open the Blender GUI, open the WinForge scripts folder
//   • headless render job builder (input .blend, output folder + name template,
//     single-frame or animation range, engine / format / device / samples)
//     with a matching CLI preview, run-now / add-to-queue / cancel
//   • a sequential batch queue rendered as a list
//   • Python-script runner: 4 shipped starter scripts (glTF / FBX / OBJ export,
//     scene info) written to %LOCALAPPDATA%\WinForge\blender-scripts, plus a
//     custom .py path
//   • an output-log tail fed by every action
// The heavy work (render / script) is driven through the local blender.exe via
// the Tauri command bridge; each launch blocks until Blender exits and the whole
// captured log is appended. Data-gathering / launching only — no destructive ops.
// ============================================================================

const ENGINES = [
  { val: '', en: "Use file's", zh: '跟檔案' },
  { val: 'CYCLES', en: 'Cycles', zh: 'Cycles' },
  { val: 'BLENDER_EEVEE', en: 'EEVEE', zh: 'EEVEE' },
  { val: 'BLENDER_WORKBENCH', en: 'Workbench', zh: 'Workbench' },
] as const;

const FORMATS = [
  { val: '', en: "Use file's", zh: '跟檔案' },
  { val: 'PNG', en: 'PNG', zh: 'PNG' },
  { val: 'JPEG', en: 'JPEG', zh: 'JPEG' },
  { val: 'OPEN_EXR', en: 'OpenEXR', zh: 'OpenEXR' },
  { val: 'TIFF', en: 'TIFF', zh: 'TIFF' },
  { val: 'WEBP', en: 'WebP', zh: 'WebP' },
  { val: 'FFMPEG', en: 'Video (FFMPEG)', zh: '影片（FFMPEG）' },
] as const;

const DEVICES = [
  { val: '', en: "Use file's", zh: '跟檔案' },
  { val: 'CPU', en: 'CPU', zh: 'CPU' },
  { val: 'GPU', en: 'GPU', zh: 'GPU' },
] as const;

// Starter Python scripts — byte-identical bodies to BlenderService.StarterScripts.
interface StarterScript {
  id: string;
  fileName: string;
  body: string;
}

const STARTER_SCRIPTS: StarterScript[] = [
  {
    id: 'gltf',
    fileName: 'export_gltf.py',
    body:
      'import bpy, os\n' +
      'src = bpy.data.filepath\n' +
      "out = os.path.splitext(src)[0] + '.glb' if src else os.path.join(bpy.app.tempdir, 'export.glb')\n" +
      "bpy.ops.export_scene.gltf(filepath=out, export_format='GLB')\n" +
      "print('Saved: ' + out)\n",
  },
  {
    id: 'fbx',
    fileName: 'export_fbx.py',
    body:
      'import bpy, os\n' +
      'src = bpy.data.filepath\n' +
      "out = os.path.splitext(src)[0] + '.fbx' if src else os.path.join(bpy.app.tempdir, 'export.fbx')\n" +
      'bpy.ops.export_scene.fbx(filepath=out)\n' +
      "print('Saved: ' + out)\n",
  },
  {
    id: 'obj',
    fileName: 'export_obj.py',
    body:
      'import bpy, os\n' +
      'src = bpy.data.filepath\n' +
      "out = os.path.splitext(src)[0] + '.obj' if src else os.path.join(bpy.app.tempdir, 'export.obj')\n" +
      'bpy.ops.wm.obj_export(filepath=out)\n' +
      "print('Saved: ' + out)\n",
  },
  {
    id: 'info',
    fileName: 'scene_info.py',
    body:
      'import bpy\n' +
      'sc = bpy.context.scene\n' +
      "print('Scene: ' + sc.name)\n" +
      "print('Objects: ' + str(len(bpy.data.objects)))\n" +
      "print('Frame range: %d-%d' % (sc.frame_start, sc.frame_end))\n" +
      "print('Engine: ' + sc.render.engine)\n",
  },
];

interface RenderJob {
  id: number;
  blendFile: string;
  outputDir: string;
  outputName: string;
  animation: boolean;
  frame: number;
  startFrame: number;
  endFrame: number;
  engine: string;
  format: string;
  device: string;
  samples: number;
}

interface Engine {
  found: boolean;
  exe: string;
  version: string;
}

// PowerShell string literal — single-quote and double any embedded quotes.
function ps(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// Quote a CLI argument (matches BlenderService.Q — wraps in double quotes).
function q(s: string): string {
  return `"${s}"`;
}

// Build the headless render argument LIST for a job. Order matters in Blender's
// CLI: globals (-b, --python-expr) → render settings (-o/-F/-E) → action last.
// Mirrors BlenderService.BuildRenderArgs.
function buildRenderArgs(job: RenderJob): string[] {
  const args: string[] = ['-b', q(job.blendFile)];

  const py: string[] = [];
  if (job.samples > 0) {
    py.push(
      `import bpy; bpy.context.scene.cycles.samples=${job.samples}; bpy.context.scene.eevee.taa_render_samples=${job.samples}`,
    );
  }
  if (job.device && job.engine === 'CYCLES') {
    if (job.device === 'GPU') {
      py.push(
        "import bpy; p=bpy.context.preferences.addons['cycles'].preferences; p.compute_device_type='CUDA'; p.get_devices(); [setattr(d,'use',True) for d in p.devices]; bpy.context.scene.cycles.device='GPU'",
      );
    } else {
      py.push("import bpy; bpy.context.scene.cycles.device='CPU'");
    }
  }
  for (const expr of py) args.push('--python-expr', q(expr));

  if (job.outputDir.trim()) {
    const name = job.outputName.trim() || 'frame_####';
    const sep = job.outputDir.endsWith('\\') || job.outputDir.endsWith('/') ? '' : '\\';
    args.push('-o', q(job.outputDir + sep + name));
  }
  if (job.format) args.push('-F', job.format);
  if (job.engine) args.push('-E', job.engine);

  if (job.animation) {
    args.push('-s', String(job.startFrame), '-e', String(job.endFrame), '-a');
  } else {
    args.push('-f', String(job.frame));
  }
  return args;
}

// Build args to run a Python script against a file (mirrors BuildScriptArgs).
function buildScriptArgs(blendFile: string, scriptPath: string): string[] {
  const args = ['-b'];
  if (blendFile.trim()) args.push(q(blendFile));
  args.push('--python', q(scriptPath));
  return args;
}

function jobTitle(job: RenderJob): string {
  const base = job.blendFile.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || job.blendFile;
  const range = job.animation ? `${job.startFrame}-${job.endFrame}` : `#${job.frame}`;
  return `${base} · ${range}${job.engine ? ` · ${job.engine}` : ''}`;
}

let nextJobId = 1;

export function BlenderModule() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh') || i18n.language.startsWith('yue');
  const pick = (en: string, zhs: string) => (zh ? zhs : en);

  // ── Engine detection: locate blender.exe + read version ────────────────────
  const engine = useAsync<Engine>(async () => {
    if (!isTauri()) return { found: false, exe: '', version: '' };
    // PATH → winget per-user Links shim → Program Files (newest folder first).
    const script = `
$ErrorActionPreference='SilentlyContinue'
$exe = $null
$c = (Get-Command blender.exe -ErrorAction SilentlyContinue).Source
if ($c) { $exe = $c }
if (-not $exe) {
  $l = Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links\\blender.exe'
  if (Test-Path $l) { $exe = $l }
}
if (-not $exe) {
  foreach ($root in @("$env:ProgramFiles\\Blender Foundation", "\${env:ProgramFiles(x86)}\\Blender Foundation")) {
    if (Test-Path $root) {
      $sub = Get-ChildItem -Directory $root -ErrorAction SilentlyContinue | Sort-Object Name -Descending
      foreach ($d in $sub) { $p = Join-Path $d.FullName 'blender.exe'; if (Test-Path $p) { $exe = $p; break } }
    }
    if ($exe) { break }
  }
}
if ($exe) {
  $v = ''
  try { $v = (& $exe --version 2>$null | Select-Object -First 1) } catch {}
  [pscustomobject]@{ found=$true; exe=$exe; version=("$v").Trim() } | ConvertTo-Json -Compress
} else {
  [pscustomobject]@{ found=$false; exe=''; version='' } | ConvertTo-Json -Compress
}`;
    const r = await runPowershell(script);
    const text = r.stdout.trim();
    if (!text) return { found: false, exe: '', version: '' };
    try {
      const o = JSON.parse(text) as Engine;
      return { found: !!o.found, exe: o.exe ?? '', version: o.version ?? '' };
    } catch {
      return { found: false, exe: '', version: '' };
    }
  }, []);

  const exe = engine.data?.exe ?? '';
  const found = engine.data?.found ?? false;

  // ── Render-job form state ──────────────────────────────────────────────────
  const [input, setInput] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [outputName, setOutputName] = useState('frame_####');
  const [animation, setAnimation] = useState(false);
  const [frame, setFrame] = useState(1);
  const [startFrame, setStartFrame] = useState(1);
  const [endFrame, setEndFrame] = useState(250);
  const [engineSel, setEngineSel] = useState('');
  const [formatSel, setFormatSel] = useState('');
  const [deviceSel, setDeviceSel] = useState('');
  const [samples, setSamples] = useState(0);

  // ── Queue + run state ──────────────────────────────────────────────────────
  const [queue, setQueue] = useState<RenderJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [log, setLog] = useState('');
  const [scriptSel, setScriptSel] = useState('gltf');
  const [customScript, setCustomScript] = useState('');

  const appendLog = (line: string) =>
    setLog((prev) => {
      const next = (prev.length ? prev + '\n' : '') + line;
      return next.length > 60000 ? next.slice(next.length - 40000) : next;
    });

  const draftJob = (): RenderJob | null => {
    if (!input.trim()) {
      appendLog(pick('! Pick an input .blend file first.', '！請先揀輸入 .blend 檔。'));
      return null;
    }
    if (!outputDir.trim()) {
      appendLog(pick('! Pick an output folder first.', '！請先揀輸出資料夾。'));
      return null;
    }
    return {
      id: nextJobId++,
      blendFile: input.trim(),
      outputDir: outputDir.trim(),
      outputName: outputName.trim() || 'frame_####',
      animation,
      frame,
      startFrame,
      endFrame,
      engine: engineSel,
      format: formatSel,
      device: deviceSel,
      samples,
    };
  };

  // Run one blender invocation to completion, streaming the captured output.
  const runBlender = async (args: string[], startMsg: string): Promise<CommandOutput> => {
    if (!isTauri()) {
      appendLog(pick('(desktop only — connect the WinForge backend to render)', '（只限桌面 — 連接 WinForge 後端先可以算圖）'));
      return { stdout: '', stderr: '', code: -1, success: false };
    }
    if (!found || !exe) {
      appendLog(pick('! Blender not found.', '！搵唔到 Blender。'));
      return { stdout: '', stderr: '', code: -1, success: false };
    }
    appendLog(`$ blender ${args.join(' ')}`);
    setProgress(startMsg);
    const r = await runCommand(exe, args);
    const out = (r.stdout || '').trim();
    if (out) appendLog(out);
    const err = (r.stderr || '').trim();
    if (err) appendLog(err);
    return r;
  };

  const runJob = async (job: RenderJob, doneMsg: string) => {
    const r = await runBlender(buildRenderArgs(job), pick('Starting…', '開始緊…'));
    if (r.success) {
      setProgress(doneMsg);
      appendLog(pick('[render finished]', '[算圖完成]'));
    } else {
      setProgress(pick('Render failed.', '算圖失敗。'));
      appendLog(pick(`[render exited ${r.code}]`, `[算圖結束 ${r.code}]`));
    }
    return r.success;
  };

  const renderNow = async () => {
    if (busy) return;
    const job = draftJob();
    if (!job) return;
    setBusy(true);
    await runJob(job, pick('Render complete.', '算圖完成。'));
    setBusy(false);
  };

  const addToQueue = () => {
    const job = draftJob();
    if (!job) return;
    setQueue((q2) => [...q2, job]);
    appendLog(pick(`[queued: ${jobTitle(job)}]`, `[已加入佇列：${jobTitle(job)}]`));
  };

  const runQueue = async () => {
    if (busy || queue.length === 0) return;
    setBusy(true);
    // Snapshot then drain sequentially, popping the front as each completes.
    let remaining = [...queue];
    while (remaining.length > 0) {
      const job = remaining[0];
      if (!job) break;
      appendLog(pick(`[queue: ${jobTitle(job)}]`, `[佇列：${jobTitle(job)}]`));
      await runJob(job, pick('Queued render complete.', '佇列算圖完成。'));
      remaining = remaining.slice(1);
      setQueue(remaining);
    }
    appendLog(pick('[queue done]', '[佇列完成]'));
    setBusy(false);
  };

  const clearQueue = () => setQueue([]);

  // Materialise a starter script to %LOCALAPPDATA%\WinForge\blender-scripts and
  // return its path (mirrors EnsureStarterScript).
  const ensureStarter = async (s: StarterScript): Promise<string | null> => {
    if (!isTauri()) return null;
    const script = `
$ErrorActionPreference='Stop'
$dir = Join-Path $env:LOCALAPPDATA 'WinForge\\blender-scripts'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$path = Join-Path $dir ${ps(s.fileName)}
[System.IO.File]::WriteAllText($path, ${ps(s.body)}, (New-Object System.Text.UTF8Encoding($false)))
$path`;
    const r = await runPowershell(script);
    const p = r.stdout.trim();
    return r.success && p ? p : null;
  };

  const runStarter = async () => {
    if (busy) return;
    const s = STARTER_SCRIPTS.find((x) => x.id === scriptSel);
    if (!s) return;
    setBusy(true);
    const path = await ensureStarter(s);
    if (!path) {
      appendLog(pick('! Could not write the starter script.', '！寫入起步 script 失敗。'));
      setBusy(false);
      return;
    }
    const r = await runBlender(buildScriptArgs(input.trim(), path), pick('Running script…', '跑緊 script…'));
    setProgress(r.success ? pick('Script done.', 'Script 完成。') : pick('Script failed.', 'Script 失敗。'));
    appendLog(r.success ? pick('[script finished]', '[script 完成]') : pick(`[script exited ${r.code}]`, `[script 結束 ${r.code}]`));
    setBusy(false);
  };

  const runCustom = async () => {
    if (busy) return;
    const path = customScript.trim();
    if (!path) {
      appendLog(pick('! Enter a .py file path first.', '！請先輸入 .py 檔路徑。'));
      return;
    }
    setBusy(true);
    const r = await runBlender(buildScriptArgs(input.trim(), path), pick('Running script…', '跑緊 script…'));
    setProgress(r.success ? pick('Script done.', 'Script 完成。') : pick('Script failed.', 'Script 失敗。'));
    appendLog(r.success ? pick('[script finished]', '[script 完成]') : pick(`[script exited ${r.code}]`, `[script 結束 ${r.code}]`));
    setBusy(false);
  };

  const openGui = async () => {
    if (!isTauri() || !exe) {
      appendLog(pick('! Blender not found.', '！搵唔到 Blender。'));
      return;
    }
    const target = input.trim();
    const args = target ? [q(target)] : [];
    appendLog(pick('[opening Blender GUI…]', '[開緊 Blender GUI…]'));
    // Launch detached via Start-Process so it does not block the UI.
    await runPowershell(
      `Start-Process ${ps(exe)}${target ? ` -ArgumentList ${ps(args.join(' '))}` : ''}`,
    );
  };

  const openScriptsFolder = async () => {
    if (!isTauri()) return;
    await runPowershell(
      `$d = Join-Path $env:LOCALAPPDATA 'WinForge\\blender-scripts'; New-Item -ItemType Directory -Force -Path $d | Out-Null; Start-Process explorer.exe $d`,
    );
  };

  const openOutput = async () => {
    if (!isTauri() || !outputDir.trim()) return;
    await runPowershell(
      `if (Test-Path ${ps(outputDir.trim())}) { Start-Process explorer.exe ${ps(outputDir.trim())} }`,
    );
  };

  // CLI preview of the job the form currently describes.
  const cliPreview = useMemo(() => {
    if (!input.trim() || !outputDir.trim()) return '';
    const job: RenderJob = {
      id: 0,
      blendFile: input.trim(),
      outputDir: outputDir.trim(),
      outputName: outputName.trim() || 'frame_####',
      animation,
      frame,
      startFrame,
      endFrame,
      engine: engineSel,
      format: formatSel,
      device: deviceSel,
      samples,
    };
    return `blender ${buildRenderArgs(job).join(' ')}`;
  }, [input, outputDir, outputName, animation, frame, startFrame, endFrame, engineSel, formatSel, deviceSel, samples]);

  const num = (v: string, fallback: number) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('blender.blurb')}
      </p>

      <ModuleToolbar>
        <button className="mini" onClick={engine.reload} disabled={engine.loading}>
          ⟳ {t('modules.refresh')}
        </button>
        {engine.data && (
          <StatusDot
            ok={found}
            label={found ? engine.data.version || t('blender.installed') : t('blender.notFound')}
          />
        )}
        <button className="mini" onClick={openGui} disabled={!found}>
          {t('blender.openGui')}
        </button>
        <button className="mini" onClick={openScriptsFolder}>
          {t('blender.openScripts')}
        </button>
      </ModuleToolbar>

      {engine.data && !found && (
        <p className="mod-msg">{t('blender.notFoundHint')}</p>
      )}
      {exe && (
        <p className="count-note" style={{ marginTop: 0, fontFamily: 'monospace' }}>
          {exe}
        </p>
      )}

      {/* ── Headless render job ── */}
      <section className="hosts-edit" style={{ marginTop: 12 }}>
        <h3>{t('blender.renderHeader')}</h3>

        <label className="count-note">{t('blender.inputLabel')}</label>
        <div className="mod-toolbar">
          <input
            className="mod-search"
            style={{ flex: 1, fontFamily: 'monospace' }}
            placeholder="C:\\path\\to\\scene.blend"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
        </div>

        <label className="count-note">{t('blender.outputLabel')}</label>
        <div className="mod-toolbar">
          <input
            className="mod-search"
            style={{ flex: 1, fontFamily: 'monospace' }}
            placeholder="C:\\renders"
            value={outputDir}
            onChange={(e) => setOutputDir(e.target.value)}
          />
        </div>
        <div className="mod-toolbar">
          <input
            className="mod-search"
            style={{ width: 240, fontFamily: 'monospace' }}
            value={outputName}
            onChange={(e) => setOutputName(e.target.value)}
          />
          <span className="count-note">{t('blender.nameHint')}</span>
        </div>

        {/* Frame / range */}
        <div className="mod-toolbar">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="radio" checked={!animation} onChange={() => setAnimation(false)} />
            {t('blender.singleFrame')}
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('blender.frame')}
            <input
              className="mod-search"
              type="number"
              min={0}
              style={{ width: 100 }}
              value={frame}
              disabled={animation}
              onChange={(e) => setFrame(num(e.target.value, 1))}
            />
          </label>
        </div>
        <div className="mod-toolbar">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="radio" checked={animation} onChange={() => setAnimation(true)} />
            {t('blender.animRange')}
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('blender.start')}
            <input
              className="mod-search"
              type="number"
              min={0}
              style={{ width: 90 }}
              value={startFrame}
              disabled={!animation}
              onChange={(e) => setStartFrame(num(e.target.value, 1))}
            />
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('blender.end')}
            <input
              className="mod-search"
              type="number"
              min={0}
              style={{ width: 90 }}
              value={endFrame}
              disabled={!animation}
              onChange={(e) => setEndFrame(num(e.target.value, 250))}
            />
          </label>
        </div>

        {/* Engine / format / device / samples */}
        <div className="mod-toolbar">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('blender.engine')}
            <select className="mod-search" value={engineSel} onChange={(e) => setEngineSel(e.target.value)}>
              {ENGINES.map((o) => (
                <option key={o.val || 'file'} value={o.val}>
                  {pick(o.en, o.zh)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('blender.format')}
            <select className="mod-search" value={formatSel} onChange={(e) => setFormatSel(e.target.value)}>
              {FORMATS.map((o) => (
                <option key={o.val || 'file'} value={o.val}>
                  {pick(o.en, o.zh)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('blender.device')}
            <select className="mod-search" value={deviceSel} onChange={(e) => setDeviceSel(e.target.value)}>
              {DEVICES.map((o) => (
                <option key={o.val || 'file'} value={o.val}>
                  {pick(o.en, o.zh)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t('blender.samples')}
            <input
              className="mod-search"
              type="number"
              min={0}
              style={{ width: 100 }}
              value={samples}
              onChange={(e) => setSamples(Math.max(0, num(e.target.value, 0)))}
            />
          </label>
        </div>

        <div className="mod-toolbar">
          <button className="mini primary" onClick={renderNow} disabled={busy || !found}>
            {t('blender.renderNow')}
          </button>
          <button className="mini" onClick={addToQueue} disabled={busy}>
            {t('blender.addQueue')}
          </button>
          <button className="mini" onClick={openOutput} disabled={!outputDir.trim()}>
            {t('blender.openOutput')}
          </button>
          {busy && <span className="count-note">{t('blender.running')}</span>}
        </div>

        {progress && <p className="count-note">{progress}</p>}
        {cliPreview && (
          <pre className="cmd-out" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
            {cliPreview}
          </pre>
        )}
      </section>

      {/* ── Batch queue ── */}
      <section className="hosts-edit" style={{ marginTop: 12 }}>
        <div className="mod-toolbar">
          <h3 style={{ flex: 1, margin: 0 }}>{t('blender.queueHeader')}</h3>
          <button className="mini primary" onClick={runQueue} disabled={busy || queue.length === 0}>
            {t('blender.runQueue')}
          </button>
          <button className="mini" onClick={clearQueue} disabled={queue.length === 0}>
            {t('blender.clear')}
          </button>
        </div>
        {queue.length === 0 ? (
          <p className="count-note">{t('blender.queueEmpty')}</p>
        ) : (
          <ul className="count-note" style={{ margin: 0, paddingLeft: 18 }}>
            {queue.map((job) => (
              <li key={job.id} style={{ fontFamily: 'monospace' }}>
                {jobTitle(job)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Python script runner ── */}
      <section className="hosts-edit" style={{ marginTop: 12 }}>
        <h3>{t('blender.scriptHeader')}</h3>
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('blender.scriptBlurb')}
        </p>
        <div className="mod-toolbar">
          <select className="mod-search" value={scriptSel} onChange={(e) => setScriptSel(e.target.value)}>
            {STARTER_SCRIPTS.map((s) => (
              <option key={s.id} value={s.id}>
                {t(`blender.script.${s.id}`)}
              </option>
            ))}
          </select>
          <button className="mini primary" onClick={runStarter} disabled={busy || !found}>
            {t('blender.runStarter')}
          </button>
        </div>
        <div className="mod-toolbar">
          <input
            className="mod-search"
            style={{ flex: 1, fontFamily: 'monospace' }}
            placeholder="C:\\path\\to\\script.py"
            value={customScript}
            onChange={(e) => setCustomScript(e.target.value)}
          />
          <button className="mini" onClick={runCustom} disabled={busy || !found || !customScript.trim()}>
            {t('blender.runCustom')}
          </button>
        </div>
      </section>

      {/* ── Output log ── */}
      <section className="hosts-edit" style={{ marginTop: 12 }}>
        <div className="mod-toolbar">
          <h3 style={{ flex: 1, margin: 0 }}>{t('blender.logHeader')}</h3>
          <button className="mini" onClick={() => setLog('')} disabled={!log}>
            {t('blender.clear')}
          </button>
        </div>
        <pre className="cmd-out" style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {log || t('blender.logEmpty')}
        </pre>
      </section>
    </div>
  );
}
