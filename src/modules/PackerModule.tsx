import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isTauri,
  listDir,
  runCommand,
  runPowershell,
  type CommandOutput,
  type DirEntry,
} from '../tauri/bridge';
import { resolveTool, findInstall, installPackage, type PackageHit } from '../tauri/deps';
import { Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

// ============================================================================
// Packer — module.packer — full native web port of WinForge's PackerModule
// (Pages/PackerModule.xaml[.cs] + Services/PackerService.cs +
// Catalog/PackerOperations.cs). A first-class front-end over the official
// HashiCorp Packer CLI (BUSL-1.1: only shells out to the binary):
//   • engine probe via resolveTool + version pill + winget→choco install offer
//     (mirrors EngineBars.AutoInstallProgress with Hashicorp.Packer)
//   • working folder: scan (*.pkr.hcl / *.pkr.json / *.json templates and
//     *.pkrvars* var-files via listDir), open in Explorer, refresh
//   • build targets parsed from `packer inspect` with -only / -except modes
//   • -var key=value editor rows and -var-file multi-select + manual add
//   • run init / validate / fmt / build / inspect through PowerShell with
//     PACKER_NO_COLOR=1 + CHECKPOINT_DISABLE=1 (same env the C# sets), a live
//     elapsed ticker, and Cancel that kills the packer.exe process tree
//   • console: append + bounded 60 000-char buffer + autoscroll, Clear,
//     Save log… (packer-YYYYMMDD-HHMMSS.log download) — mirrors AppendLine
//   • run history table with duration / exit status
//   • builder starter presets (null / docker / amazon-ebs / azure-arm /
//     hyperv-iso / virtualbox-iso): preview, copy, save into the folder with
//     an explicit overwrite confirm
//   • plugins: install by source address, list installed, show required
//   • filterable operations list (version+found-pill, help, fmt-check,
//     fmt-write, plugins installed/required, inspect) with a persistent
//     status line — mirrors PackerOperations.All() + OpsStatusBar
// Reads auto-run; every packer invocation runs only on explicit click; var
// values are masked in the echoed command line and history. In the plain
// browser the full UI renders as a preview (bridge no-ops).
// ============================================================================

interface VarRow {
  key: string;
  value: string;
}

interface VarFileEntry {
  name: string;
  path: string;
}

interface RunRecord {
  id: number;
  label: string;
  cmd: string;
  at: number;
  ms: number;
  code: number;
  ok: boolean;
}

interface EngineInfo {
  path: string | null;
  source: string;
  version: string;
}

interface Preset {
  id: string;
  file: string;
  body: string;
}

const STUB: CommandOutput = { stdout: '', stderr: '', code: -1, success: false };

async function runCmdSafe(program: string, args: string[]): Promise<CommandOutput> {
  if (!isTauri()) return { ...STUB };
  try {
    return await runCommand(program, args);
  } catch (e) {
    return { stdout: '', stderr: String(e), code: -1, success: false };
  }
}

async function pshellSafe(script: string): Promise<CommandOutput> {
  if (!isTauri()) return { ...STUB };
  try {
    return await runPowershell(script);
  } catch (e) {
    return { stdout: '', stderr: String(e), code: -1, success: false };
  }
}

/** PowerShell single-quote escape. */
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

// Template patterns Packer recognises (PackerService.ListTemplates).
function isTemplate(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.pkr.hcl') || n.endsWith('.pkr.json') || n.endsWith('.json');
}
// Var-file patterns (PackerService.ListVarFiles).
function isVarFile(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.endsWith('.pkrvars.hcl') ||
    n.endsWith('.pkrvars.json') ||
    n.endsWith('.auto.pkrvars.hcl') ||
    n.endsWith('.auto.pkrvars.json')
  );
}

/** Parse build/source targets from `packer inspect` (PackerService.ListBuildTargetsAsync). */
function parseBuildTargets(raw: string): string[] {
  const found = new Set<string>();
  let inBuilds = false;
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (/^builds:/i.test(trimmed)) {
      inBuilds = true;
      continue;
    }
    if (!inBuilds) continue;
    const first = line[0];
    if (trimmed.length > 0 && first !== undefined && !/\s/.test(first) && trimmed.endsWith(':')) break;
    let name = trimmed.replace(/^[>\-\s\t]+/, '');
    const colon = name.indexOf(':');
    if (colon > 0) name = name.slice(0, colon);
    name = name.trim();
    const c0 = name[0];
    if (name.length > 0 && c0 !== undefined && (name.includes('.') || name.includes('-') || /[a-zA-Z]/.test(c0))) {
      found.add(name);
    }
  }
  return Array.from(found).sort();
}

/** Echoed command line with -var values masked (never log secrets). */
function displayCmd(args: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '-var') {
      const nxt = args[i + 1];
      if (nxt !== undefined) {
        const eq = nxt.indexOf('=');
        parts.push('-var', eq > 0 ? `${nxt.slice(0, eq)}=***` : nxt);
        i++;
        continue;
      }
    }
    parts.push(/\s/.test(a) ? `"${a}"` : a);
  }
  return `packer ${parts.join(' ')}`;
}

// Starter templates for common builders — ASCII-only so btoa() is safe.
const PRESETS: readonly Preset[] = [
  {
    id: 'null',
    file: 'null.pkr.hcl',
    body: [
      'source "null" "smoke" {',
      '  communicator = "none"',
      '}',
      '',
      'build {',
      '  sources = ["source.null.smoke"]',
      '',
      '  provisioner "shell-local" {',
      '    inline = ["echo Hello from Packer"]',
      '  }',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'docker',
    file: 'docker.pkr.hcl',
    body: [
      'packer {',
      '  required_plugins {',
      '    docker = {',
      '      source  = "github.com/hashicorp/docker"',
      '      version = ">= 1.0.0"',
      '    }',
      '  }',
      '}',
      '',
      'source "docker" "ubuntu" {',
      '  image  = "ubuntu:22.04"',
      '  commit = true',
      '}',
      '',
      'build {',
      '  sources = ["source.docker.ubuntu"]',
      '',
      '  provisioner "shell" {',
      '    inline = ["apt-get update", "apt-get install -y curl"]',
      '  }',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'amazon-ebs',
    file: 'aws-ebs.pkr.hcl',
    body: [
      'packer {',
      '  required_plugins {',
      '    amazon = {',
      '      source  = "github.com/hashicorp/amazon"',
      '      version = ">= 1.2.0"',
      '    }',
      '  }',
      '}',
      '',
      'variable "region" {',
      '  type    = string',
      '  default = "us-east-1"',
      '}',
      '',
      'source "amazon-ebs" "base" {',
      '  region        = var.region',
      '  instance_type = "t3.micro"',
      '  ssh_username  = "ubuntu"',
      '  ami_name      = "winforge-{{timestamp}}"',
      '',
      '  source_ami_filter {',
      '    filters = {',
      '      name                = "ubuntu/images/*ubuntu-jammy-22.04-amd64-server-*"',
      '      root-device-type    = "ebs"',
      '      virtualization-type = "hvm"',
      '    }',
      '    most_recent = true',
      '    owners      = ["099720109477"]',
      '  }',
      '}',
      '',
      'build {',
      '  sources = ["source.amazon-ebs.base"]',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'azure-arm',
    file: 'azure-arm.pkr.hcl',
    body: [
      'packer {',
      '  required_plugins {',
      '    azure = {',
      '      source  = "github.com/hashicorp/azure"',
      '      version = ">= 2.0.0"',
      '    }',
      '  }',
      '}',
      '',
      'source "azure-arm" "base" {',
      '  use_azure_cli_auth                = true',
      '  os_type                           = "Windows"',
      '  image_publisher                   = "MicrosoftWindowsServer"',
      '  image_offer                       = "WindowsServer"',
      '  image_sku                         = "2022-datacenter-core"',
      '  managed_image_name                = "winforge-image"',
      '  managed_image_resource_group_name = "my-rg"',
      '  location                          = "eastus"',
      '  vm_size                           = "Standard_D2s_v3"',
      '  communicator                      = "winrm"',
      '  winrm_use_ssl                     = true',
      '  winrm_insecure                    = true',
      '  winrm_username                    = "packer"',
      '}',
      '',
      'build {',
      '  sources = ["source.azure-arm.base"]',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'hyperv-iso',
    file: 'hyperv.pkr.hcl',
    body: [
      'packer {',
      '  required_plugins {',
      '    hyperv = {',
      '      source  = "github.com/hashicorp/hyperv"',
      '      version = ">= 1.1.0"',
      '    }',
      '  }',
      '}',
      '',
      'source "hyperv-iso" "vm" {',
      '  iso_url          = "file:///C:/ISO/ubuntu-22.04.iso"',
      '  iso_checksum     = "none"',
      '  generation       = 2',
      '  switch_name      = "Default Switch"',
      '  memory           = 4096',
      '  cpus             = 2',
      '  disk_size        = 40960',
      '  ssh_username     = "ubuntu"',
      '  ssh_password     = "ubuntu"',
      '  shutdown_command = "sudo shutdown -P now"',
      '}',
      '',
      'build {',
      '  sources = ["source.hyperv-iso.vm"]',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'virtualbox-iso',
    file: 'virtualbox.pkr.hcl',
    body: [
      'packer {',
      '  required_plugins {',
      '    virtualbox = {',
      '      source  = "github.com/hashicorp/virtualbox"',
      '      version = ">= 1.0.0"',
      '    }',
      '  }',
      '}',
      '',
      'source "virtualbox-iso" "vm" {',
      '  guest_os_type    = "Ubuntu_64"',
      '  iso_url          = "file:///C:/ISO/ubuntu-22.04.iso"',
      '  iso_checksum     = "none"',
      '  memory           = 4096',
      '  cpus             = 2',
      '  disk_size        = 40960',
      '  ssh_username     = "ubuntu"',
      '  ssh_password     = "ubuntu"',
      '  shutdown_command = "sudo shutdown -P now"',
      '}',
      '',
      'build {',
      '  sources = ["source.virtualbox-iso.vm"]',
      '}',
      '',
    ].join('\n'),
  },
];

const FALLBACK_PRESET: Preset = { id: 'null', file: 'null.pkr.hcl', body: '' };

const LOG_LIMIT = 60000; // same on-screen bound as the C# console

export function PackerModule() {
  const { t } = useTranslation();
  const live = isTauri();

  // ---- engine probe (CheckEngine): resolveTool + version pill ----
  const engineQ = useAsync<EngineInfo>(async () => {
    if (!live) return { path: null, source: '', version: '' };
    let path: string | null = null;
    let source = '';
    try {
      const r = await resolveTool('packer');
      path = r.path;
      source = r.source;
    } catch {
      path = null;
    }
    if (!path) return { path: null, source: 'missing', version: '' };
    const v = await runCmdSafe(path, ['version']);
    const line =
      (v.stdout + '\n' + v.stderr).split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';
    return { path, source, version: line };
  }, [live]);
  const enginePath = engineQ.data?.path ?? null;
  const engineMissing = live && !engineQ.loading && !enginePath;
  const exe = enginePath ?? 'packer';

  // ---- working folder & scans ----
  const [folder, setFolder] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState('');
  const [templates, setTemplates] = useState<string[]>([]);
  const [selTemplate, setSelTemplate] = useState('');
  const [varFiles, setVarFiles] = useState<VarFileEntry[]>([]);
  const [selVarFiles, setSelVarFiles] = useState<string[]>([]);
  const [varFileInput, setVarFileInput] = useState('');

  // ---- variables ----
  const [vars, setVars] = useState<VarRow[]>([{ key: '', value: '' }]);

  // ---- targets ----
  const [targets, setTargets] = useState<string[]>([]);
  const [selTargets, setSelTargets] = useState<string[]>([]);
  const [targetMode, setTargetMode] = useState<'only' | 'except'>('only');
  const [targetsMsg, setTargetsMsg] = useState('');

  // ---- console / run state ----
  const [logText, setLogText] = useState('');
  const logRef = useRef<HTMLPreElement | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState('');
  const [history, setHistory] = useState<RunRecord[]>([]);

  // ---- ops / plugins / presets ----
  const [opsFilter, setOpsFilter] = useState('');
  const [opsMsg, setOpsMsg] = useState('');
  const [pluginSrc, setPluginSrc] = useState('');
  const [presetId, setPresetId] = useState('docker');
  const [presetFile, setPresetFile] = useState('docker.pkr.hcl');
  const [presetMsg, setPresetMsg] = useState('');
  const [overwriteArmed, setOverwriteArmed] = useState(false);

  const dir = folder.trim();

  // Console autoscroll (ConsoleScroll.ChangeView equivalent).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logText]);

  // Elapsed-seconds ticker while a command runs (BusyRing + live status).
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const append = (chunk: string, header = false) => {
    setLogText((cur) => {
      const text = header ? `\n${chunk}\n` : `${chunk}\n`;
      const next = cur + text;
      return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
    });
  };

  // ---- path helpers ----
  const joinPath = (name: string): string => {
    const base = dir.replace(/[\\/]+$/, '');
    return base ? `${base}\\${name}` : name;
  };
  const templatePath = (): string => (selTemplate ? joinPath(selTemplate) : dir);
  const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

  // ---- folder scanning (RefreshFolder) ----
  const scanFolder = async () => {
    if (!dir) {
      setScanErr(t('packer.pickFirst'));
      return;
    }
    setScanErr('');
    setScanning(true);
    try {
      const entries: DirEntry[] = await listDir(dir);
      const files = entries.filter((e) => !e.is_dir);
      const tpls = files.map((e) => e.name).filter(isTemplate).sort();
      const vfs = files
        .filter((e) => isVarFile(e.name))
        .map((e) => ({ name: e.name, path: e.path }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setTemplates(tpls);
      setVarFiles((cur) => {
        // keep manually added var-files that live outside the folder
        const outside = cur.filter(
          (v) => !vfs.some((n) => n.path.toLowerCase() === v.path.toLowerCase()) && !v.path.toLowerCase().startsWith(dir.toLowerCase()),
        );
        return [...vfs, ...outside];
      });
      setSelTemplate((cur) => (cur && tpls.includes(cur) ? cur : ''));
      setSelVarFiles((cur) => cur.filter((p) => vfs.some((v) => v.path === p) || !p.toLowerCase().startsWith(dir.toLowerCase())));
      setTargets([]);
      setSelTargets([]);
      setTargetsMsg('');
      if (tpls.length === 0) setScanErr(t('packer.noTemplates'));
    } catch (e) {
      setTemplates([]);
      setVarFiles([]);
      setScanErr(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  };

  const openFolder = async () => {
    if (!dir || !live) return;
    await runCmdSafe('explorer.exe', [dir]);
  };

  // ---- variables (AddVarRow / CollectVars) ----
  const setVar = (i: number, patch: Partial<VarRow>) =>
    setVars((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addVar = () => setVars((rows) => [...rows, { key: '', value: '' }]);
  const removeVar = (i: number) => setVars((rows) => rows.filter((_, idx) => idx !== i));

  const varArgs = (): string[] => {
    const out: string[] = [];
    for (const r of vars) {
      const k = r.key.trim();
      if (!k) continue;
      out.push('-var', `${k}=${r.value}`);
    }
    for (const p of selVarFiles) out.push(`-var-file=${p}`);
    return out;
  };

  const targetArgs = (): string[] => {
    if (selTargets.length === 0) return [];
    const flag = targetMode === 'except' ? '-except' : '-only';
    return [`${flag}=${selTargets.join(',')}`];
  };

  // ---- var-files (AddVarFile / RefreshVarFiles) ----
  const toggleVarFile = (path: string) =>
    setSelVarFiles((cur) => (cur.includes(path) ? cur.filter((v) => v !== path) : [...cur, path]));

  const addVarFile = () => {
    const raw = varFileInput.trim();
    if (!raw) return;
    const full = /[:\\/]/.test(raw) ? raw : joinPath(raw);
    setVarFiles((cur) =>
      cur.some((v) => v.path.toLowerCase() === full.toLowerCase())
        ? cur
        : [...cur, { name: baseName(full), path: full }],
    );
    setSelVarFiles((cur) => (cur.includes(full) ? cur : [...cur, full])); // auto-select, like the C#
    setVarFileInput('');
  };

  // ---- run pipeline (StreamRun equivalent over run_powershell) ----
  const requireFolder = (): boolean => {
    if (!dir) {
      setScanErr(t('packer.pickFirst'));
      return false;
    }
    return true;
  };

  const runPk = async (
    label: string,
    args: string[],
    opts?: { silent?: boolean; noHistory?: boolean },
  ): Promise<CommandOutput | null> => {
    if (running) {
      setStatus(t('packer.alreadyRunning'));
      return null;
    }
    const silent = opts?.silent === true;
    const shownCmd = displayCmd(args);
    setRunning(label);
    setElapsed(0);
    if (!silent) append(`$ ${shownCmd}`, true);

    if (!live) {
      if (!silent) append(t('packer.previewNote'));
      setStatus(t('packer.previewNote'));
      setRunning(null);
      return null;
    }

    const started = Date.now();
    // Same env the C# sets (colourless, no checkpoint) + UTF-8 output, cwd = folder.
    const psArgs = args.map((a) => `'${psq(a)}'`).join(' ');
    const cd = dir
      ? `if (Test-Path -LiteralPath '${psq(dir)}') { Set-Location -LiteralPath '${psq(dir)}' }; `
      : '';
    const script =
      `try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; ` +
      `$env:PACKER_NO_COLOR='1'; $env:CHECKPOINT_DISABLE='1'; ${cd}` +
      `& '${psq(exe)}' ${psArgs}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } exit 1`;
    const res = await pshellSafe(script);
    const ms = Date.now() - started;
    const secs = Math.max(1, Math.round(ms / 1000));

    if (!silent) {
      const body = [res.stdout, res.stderr]
        .map((s) => s.replace(/\r/g, '').trim())
        .filter((s) => s.length > 0)
        .join('\n');
      append(body || `(exit ${res.code})`);
      append(res.success ? `✓ ${label} (exit 0)` : `✗ ${label} (exit ${res.code})`, true);
    }
    setStatus(
      res.success
        ? t('packer.statusDone', { label, s: secs })
        : t('packer.statusFail', { label, code: res.code, s: secs }),
    );
    if (opts?.noHistory !== true) {
      setHistory((h) =>
        [
          { id: Date.now(), label, cmd: shownCmd, at: started, ms, code: res.code, ok: res.success },
          ...h,
        ].slice(0, 50),
      );
    }
    setRunning(null);
    return res;
  };

  // Cancel = kill the packer process tree (PackerService.Cancel).
  const cancelRun = async () => {
    setStatus(t('packer.cancelling'));
    append(t('packer.cancelling'), true);
    await runCmdSafe('taskkill', ['/IM', 'packer.exe', '/T', '/F']);
  };

  // ---- primary commands ----
  const doInit = () => {
    if (requireFolder()) void runPk('packer init', ['init', dir]);
  };
  const doValidate = () => {
    if (requireFolder())
      void runPk('packer validate', ['validate', ...varArgs(), ...targetArgs(), templatePath()]);
  };
  const doFmt = () => {
    if (requireFolder()) void runPk('packer fmt', ['fmt', dir]);
  };
  const doBuild = () => {
    if (requireFolder())
      void runPk('packer build', ['build', ...varArgs(), ...targetArgs(), templatePath()]);
  };
  const doInspect = () => {
    if (requireFolder()) void runPk('packer inspect', ['inspect', templatePath()]);
  };

  // ---- InspectTargets_Click: parse -only/-except candidates ----
  const inspectTargets = async () => {
    if (!requireFolder()) return;
    setTargetsMsg(t('packer.inspecting'));
    const res = await runPk('packer inspect', ['inspect', templatePath()], {
      silent: true,
      noHistory: true,
    });
    if (!res) {
      setTargetsMsg(live ? t('packer.alreadyRunning') : t('packer.previewNote'));
      return;
    }
    const list = parseBuildTargets((res.stdout || '') + '\n' + (res.stderr || ''));
    setTargets(list);
    setSelTargets((cur) => cur.filter((x) => list.includes(x)));
    setTargetsMsg(list.length === 0 ? t('packer.noTargets') : t('packer.targetsFound', { n: list.length }));
  };

  const toggleTarget = (name: string) =>
    setSelTargets((cur) => (cur.includes(name) ? cur.filter((v) => v !== name) : [...cur, name]));

  // ---- console actions ----
  const clearConsole = () => {
    setLogText('');
    setStatus('');
  };

  const saveLog = () => {
    if (!logText.trim()) {
      setStatus(t('packer.nothingToSave'));
      return;
    }
    try {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const name = `packer-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`;
      const blob = new Blob([logText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(t('packer.savedAs', { name }));
    } catch (e) {
      setStatus(t('packer.saveFailed', { err: e instanceof Error ? e.message : String(e) }));
    }
  };

  // ---- plugins ----
  const installPlugin = async () => {
    const src = pluginSrc.trim();
    if (!src) return;
    const res = await runPk('plugins install', ['plugins', 'install', src]);
    if (res) setOpsMsg(res.success ? `✓ plugins install ${src}` : `✗ plugins install (exit ${res.code})`);
  };

  // ---- builder presets ----
  const activePreset: Preset = useMemo(
    () => PRESETS.find((p) => p.id === presetId) ?? PRESETS[0] ?? FALLBACK_PRESET,
    [presetId],
  );

  const pickPreset = (id: string) => {
    setPresetId(id);
    const p = PRESETS.find((x) => x.id === id);
    setPresetFile(p ? p.file : '');
    setPresetMsg('');
    setOverwriteArmed(false);
  };

  const copyPreset = async () => {
    try {
      await navigator.clipboard.writeText(activePreset.body);
      setPresetMsg(t('packer.presetCopied'));
    } catch (e) {
      setPresetMsg(String(e));
    }
  };

  const savePreset = async () => {
    if (!requireFolder()) return;
    if (!live) {
      setPresetMsg(t('packer.previewNote'));
      return;
    }
    const name = presetFile.trim() || activePreset.file;
    const full = joinPath(name);
    try {
      if (!overwriteArmed) {
        const chk = await pshellSafe(
          `if (Test-Path -LiteralPath '${psq(full)}') { 'yes' } else { 'no' }`,
        );
        if (chk.stdout.trim().toLowerCase() === 'yes') {
          setOverwriteArmed(true);
          setPresetMsg(t('packer.presetOverwriteConfirm'));
          return;
        }
      }
      setOverwriteArmed(false);
      const b64 = btoa(activePreset.body);
      const res = await pshellSafe(
        `$b=[Convert]::FromBase64String('${b64}'); [IO.File]::WriteAllBytes('${psq(full)}', $b); 'ok'`,
      );
      if (!res.success || !res.stdout.includes('ok'))
        throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setPresetMsg(t('packer.presetSaved', { name }));
      void scanFolder();
    } catch (e) {
      setPresetMsg(t('packer.saveFailed', { err: e instanceof Error ? e.message : String(e) }));
    }
  };

  // ---- operations catalog (PackerOperations.All) ----
  interface OpDef {
    id: string;
    title: string;
    desc: string;
    btn: string;
    needsFolder: boolean;
    pill: boolean;
    args: () => string[];
  }
  const ops: OpDef[] = [
    {
      id: 'version',
      title: t('packer.opVersion'),
      desc: t('packer.opVersionDesc'),
      btn: t('packer.opVersionBtn'),
      needsFolder: false,
      pill: true,
      args: () => ['version'],
    },
    {
      id: 'help',
      title: t('packer.opHelp'),
      desc: t('packer.opHelpDesc'),
      btn: t('packer.opHelpBtn'),
      needsFolder: false,
      pill: false,
      args: () => ['--help'],
    },
    {
      id: 'fmt-check',
      title: t('packer.opFmtCheck'),
      desc: t('packer.opFmtCheckDesc'),
      btn: t('packer.opFmtCheckBtn'),
      needsFolder: true,
      pill: false,
      args: () => ['fmt', '-check', '-diff', dir],
    },
    {
      id: 'fmt-write',
      title: t('packer.opFmtWrite'),
      desc: t('packer.opFmtWriteDesc'),
      btn: t('packer.opFmtWriteBtn'),
      needsFolder: true,
      pill: false,
      args: () => ['fmt', dir],
    },
    {
      id: 'plugins-installed',
      title: t('packer.opPluginsInstalled'),
      desc: t('packer.opPluginsInstalledDesc'),
      btn: t('packer.opPluginsInstalledBtn'),
      needsFolder: false,
      pill: false,
      args: () => ['plugins', 'installed'],
    },
    {
      id: 'plugins-required',
      title: t('packer.opPluginsRequired'),
      desc: t('packer.opPluginsRequiredDesc'),
      btn: t('packer.opPluginsRequiredBtn'),
      needsFolder: true,
      pill: false,
      args: () => ['plugins', 'required', dir],
    },
    {
      id: 'inspect',
      title: t('packer.opInspect'),
      desc: t('packer.opInspectDesc'),
      btn: t('packer.opInspectBtn'),
      needsFolder: true,
      pill: false,
      args: () => ['inspect', dir],
    },
  ];

  const q = opsFilter.trim().toLowerCase();
  const shownOps = q
    ? ops.filter((o) => `${o.id} ${o.title} ${o.desc}`.toLowerCase().includes(q))
    : ops;

  const runOp = async (op: OpDef) => {
    if (op.needsFolder && !dir) {
      setOpsMsg(t('packer.pickFirst'));
      return;
    }
    const res = await runPk(op.title, op.args());
    if (res) setOpsMsg(res.success ? `✓ ${op.title}` : `✗ ${op.title} (exit ${res.code})`);
    else if (!live) setOpsMsg(t('packer.previewNote'));
  };

  const blocked = !!running;
  const runDisabled = blocked || engineMissing;

  const opCols: Column<OpDef>[] = [
    {
      key: 'op',
      header: t('packer.opsColOp'),
      render: (o) => (
        <span>
          <span style={{ fontWeight: 600 }}>{o.title}</span>
          <br />
          <span className="count-note" style={{ margin: 0 }}>{o.desc}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: t('packer.histStatus'),
      width: 150,
      render: (o) =>
        o.pill && live && !engineQ.loading ? (
          <StatusDot ok={!!enginePath} label={enginePath ? t('packer.foundPill') : t('packer.notOnPath')} />
        ) : (
          <span className="count-note" style={{ margin: 0 }}>—</span>
        ),
    },
    {
      key: 'action',
      header: '',
      width: 110,
      align: 'right',
      render: (o) => (
        <button className="mini" disabled={runDisabled} onClick={() => void runOp(o)}>
          {o.btn}
        </button>
      ),
    },
  ];

  const histCols: Column<RunRecord>[] = [
    {
      key: 'at',
      header: t('packer.histTime'),
      width: 100,
      render: (r) => new Date(r.at).toLocaleTimeString(),
    },
    {
      key: 'cmd',
      header: t('packer.histCmd'),
      render: (r) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.cmd}</span>,
    },
    {
      key: 'ms',
      header: t('packer.histDur'),
      width: 90,
      align: 'right',
      render: (r) => `${(r.ms / 1000).toFixed(1)}s`,
    },
    {
      key: 'ok',
      header: t('packer.histStatus'),
      width: 120,
      render: (r) => <StatusDot ok={r.ok} label={r.ok ? t('packer.statusOk') : `exit ${r.code}`} />,
    },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('packer.blurb')}</p>

      {/* ---- engine strip: preview note / not-found bar / version pill ---- */}
      {!live && (
        <p className="count-note" style={{ marginTop: 0 }}>{t('packer.previewNote')}</p>
      )}
      {live && enginePath && (
        <p className="count-note" style={{ marginTop: 0 }}>
          <StatusDot
            ok
            label={(engineQ.data?.version || 'packer') + (engineQ.data?.source ? ` · ${engineQ.data.source}` : '')}
          />
        </p>
      )}
      {engineMissing && (
        <>
          <p className="mod-msg">
            {t('packer.engineMissing')} — {t('packer.engineMissingMsg')}
          </p>
          <InstallOffer onDone={engineQ.reload} />
        </>
      )}

      {/* ---- Working folder, templates & build targets ---- */}
      <div className="panel">
        <div className="label">{t('packer.folderHeader')}</div>
        <ModuleToolbar>
          <input
            className="mod-search"
            style={{ minWidth: 260, flex: 1 }}
            placeholder={t('packer.folderPlaceholder')}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void scanFolder()}
          />
          <button className="mini primary" disabled={scanning} onClick={() => void scanFolder()}>
            {scanning ? t('packer.scanning') : t('packer.scan')}
          </button>
          <button className="mini" disabled={scanning} onClick={() => void scanFolder()}>
            ⟳ {t('modules.refresh')}
          </button>
          <button className="mini" disabled={!live || !dir} onClick={() => void openFolder()}>
            {t('packer.openFolder')}
          </button>
        </ModuleToolbar>
        {scanErr && <p className="count-note error" style={{ marginBottom: 0 }}>{scanErr}</p>}

        <div className="io-grid" style={{ marginTop: 8 }}>
          <div>
            <div className="label">{t('packer.templatesLabel')}</div>
            <select
              className="mod-select"
              style={{ width: '100%' }}
              value={selTemplate}
              onChange={(e) => setSelTemplate(e.target.value)}
            >
              <option value="">{t('packer.wholeFolder')}</option>
              {templates.map((tpl) => (
                <option key={tpl} value={tpl}>{tpl}</option>
              ))}
            </select>
            {templates.length === 0 && (
              <p className="count-note" style={{ marginBottom: 0 }}>{t('packer.noTemplates')}</p>
            )}
          </div>
          <div>
            <div className="label">{t('packer.targetsHeader')}</div>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <button className="mini" disabled={runDisabled} onClick={() => void inspectTargets()}>
                {t('packer.inspectTargets')}
              </button>
              <label className="chk">
                <input
                  type="radio"
                  name="pk-target-mode"
                  checked={targetMode === 'only'}
                  onChange={() => setTargetMode('only')}
                />
                {' '}{t('packer.only')}
              </label>
              <label className="chk">
                <input
                  type="radio"
                  name="pk-target-mode"
                  checked={targetMode === 'except'}
                  onChange={() => setTargetMode('except')}
                />
                {' '}{t('packer.except')}
              </label>
            </div>
            {targets.length === 0 ? (
              <p className="count-note" style={{ margin: 0 }}>{targetsMsg || t('packer.targetsHint')}</p>
            ) : (
              <>
                {targetsMsg && <p className="count-note" style={{ margin: '0 0 4px' }}>{targetsMsg}</p>}
                {targets.map((tg) => (
                  <label key={tg} className="chk" style={{ display: 'block' }}>
                    <input type="checkbox" checked={selTargets.includes(tg)} onChange={() => toggleTarget(tg)} />
                    {' '}<span style={{ fontFamily: 'monospace' }}>{tg}</span>
                  </label>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ---- Variables & var-files ---- */}
      <div className="panel">
        <div className="label">{t('packer.varsHeader')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>{t('packer.varsBlurb')}</p>
        {vars.map((r, i) => (
          <div key={i} className="mod-toolbar" style={{ marginBottom: 4 }}>
            <input
              className="mod-search"
              style={{ maxWidth: 180 }}
              placeholder={t('packer.varKey')}
              value={r.key}
              onChange={(e) => setVar(i, { key: e.target.value })}
            />
            <input
              className="mod-search"
              style={{ flex: 1, minWidth: 160 }}
              placeholder={t('packer.varValue')}
              value={r.value}
              onChange={(e) => setVar(i, { value: e.target.value })}
            />
            <button
              className="mini"
              onClick={() => removeVar(i)}
              disabled={vars.length === 1 && !r.key && !r.value}
            >
              {t('packer.removeVar')}
            </button>
          </div>
        ))}
        <button className="mini" onClick={addVar}>{t('packer.addVar')}</button>

        <div className="label" style={{ marginTop: 10 }}>{t('packer.varFilesLabel')}</div>
        {varFiles.length === 0 && (
          <p className="count-note" style={{ margin: 0 }}>{t('packer.noVarFiles')}</p>
        )}
        {varFiles.map((vf) => (
          <label key={vf.path} className="chk" style={{ display: 'block' }} title={vf.path}>
            <input
              type="checkbox"
              checked={selVarFiles.includes(vf.path)}
              onChange={() => toggleVarFile(vf.path)}
            />
            {' '}{vf.name}
          </label>
        ))}
        <div className="mod-toolbar" style={{ marginTop: 6 }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={t('packer.varFilePlaceholder')}
            value={varFileInput}
            onChange={(e) => setVarFileInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addVarFile()}
          />
          <button className="mini" disabled={!varFileInput.trim()} onClick={addVarFile}>
            {t('packer.addVarFile')}
          </button>
          <button className="mini" disabled={scanning || !dir} onClick={() => void scanFolder()}>
            {t('packer.scan')}
          </button>
        </div>
      </div>

      {/* ---- Run + console ---- */}
      <div className="panel">
        <div className="label">{t('packer.runHeader')}</div>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <button className="mini primary" disabled={runDisabled} onClick={doInit}>{t('packer.init')}</button>
          <button className="mini" disabled={runDisabled} onClick={doValidate}>{t('packer.validate')}</button>
          <button className="mini" disabled={runDisabled} onClick={doFmt}>{t('packer.fmt')}</button>
          <button className="mini primary" disabled={runDisabled} onClick={doBuild}>{t('packer.build')}</button>
          <button className="mini" disabled={runDisabled} onClick={doInspect}>{t('packer.inspect')}</button>
          <button className="mini" disabled={!running || !live} onClick={() => void cancelRun()}>
            {t('packer.cancel')}
          </button>
        </div>
        {(running || status) && (
          <p className="count-note" style={{ margin: '4px 0' }}>
            {running ? t('packer.statusRunning', { label: running, s: elapsed }) : status}
          </p>
        )}

        <div className="label">{t('packer.consoleLabel')}</div>
        <pre
          ref={logRef}
          className="cmd-out"
          style={{ marginTop: 4, maxHeight: 320, whiteSpace: 'pre-wrap' }}
        >
          {logText || ' '}
        </pre>
        <div className="mod-toolbar" style={{ marginTop: 6 }}>
          <button className="mini" onClick={clearConsole}>{t('packer.clearConsole')}</button>
          <button className="mini" onClick={saveLog}>{t('packer.saveLog')}</button>
        </div>
      </div>

      {/* ---- Run history ---- */}
      <div className="panel">
        <div className="label">{t('packer.historyHeader')}</div>
        <DataTable
          columns={histCols}
          rows={history}
          rowKey={(r, i) => `${r.id}-${i}`}
          empty={t('packer.histEmpty')}
        />
        {history.length > 0 && (
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini" onClick={() => setHistory([])}>{t('packer.clearHistory')}</button>
          </div>
        )}
      </div>

      {/* ---- Builder presets ---- */}
      <div className="panel">
        <div className="label">{t('packer.presetsHeader')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>{t('packer.presetsBlurb')}</p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <select className="mod-select" value={presetId} onChange={(e) => pickPreset(e.target.value)}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.id}</option>
            ))}
          </select>
          <input
            className="mod-search"
            style={{ maxWidth: 220 }}
            placeholder={t('packer.presetFilePlaceholder')}
            value={presetFile}
            onChange={(e) => {
              setPresetFile(e.target.value);
              setOverwriteArmed(false);
            }}
          />
          <button className="mini" onClick={() => void copyPreset()}>{t('packer.presetCopy')}</button>
          <button
            className={overwriteArmed ? 'mini primary' : 'mini'}
            disabled={blocked}
            onClick={() => void savePreset()}
          >
            {t('packer.presetSave')}
          </button>
        </div>
        {presetMsg && <p className="count-note" style={{ margin: '4px 0' }}>{presetMsg}</p>}
        <textarea
          className="hosts-edit"
          readOnly
          value={activePreset.body}
          style={{ width: '100%', minHeight: 180, fontFamily: 'monospace', fontSize: 12 }}
        />
      </div>

      {/* ---- Plugins ---- */}
      <div className="panel">
        <div className="label">{t('packer.pluginsHeader')}</div>
        <p className="count-note" style={{ marginTop: 0 }}>{t('packer.pluginsBlurb')}</p>
        <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
          <input
            className="mod-search"
            style={{ flex: 1, minWidth: 240 }}
            placeholder={t('packer.pluginSrcPlaceholder')}
            value={pluginSrc}
            onChange={(e) => setPluginSrc(e.target.value)}
          />
          <button
            className="mini primary"
            disabled={runDisabled || !pluginSrc.trim()}
            onClick={() => void installPlugin()}
          >
            {t('packer.pluginInstall')}
          </button>
          <button
            className="mini"
            disabled={runDisabled}
            onClick={() => void runPk(t('packer.opPluginsInstalled'), ['plugins', 'installed'])}
          >
            {t('packer.opPluginsInstalled')}
          </button>
          <button
            className="mini"
            disabled={runDisabled || !dir}
            onClick={() => void runPk(t('packer.opPluginsRequired'), ['plugins', 'required', dir])}
          >
            {t('packer.opPluginsRequired')}
          </button>
        </div>
      </div>

      {/* ---- More operations (filterable, persistent status line) ---- */}
      <div className="panel">
        <div className="label">{t('packer.opsHeader')}</div>
        <ModuleToolbar>
          <input
            className="mod-search"
            placeholder={t('packer.opsFilterPlaceholder')}
            value={opsFilter}
            onChange={(e) => setOpsFilter(e.target.value)}
          />
        </ModuleToolbar>
        {opsMsg && <p className="mod-msg">{opsMsg}</p>}
        <DataTable columns={opCols} rows={shownOps} rowKey={(o) => o.id} />
      </div>

      <p className="count-note">{t('packer.note')}</p>
    </div>
  );
}

/**
 * Inline install offer for a missing packer binary — same winget-first,
 * Chocolatey-fallback machinery the DependencyGate used (EngineBars
 * AutoInstallProgress equivalent), shown without hiding the module UI.
 */
function InstallOffer({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [hit, setHit] = useState<PackageHit | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const search = async () => {
    setBusy(true);
    setMsg(t('deps.searching'));
    try {
      const found = await findInstall('packer', 'Hashicorp.Packer');
      setHit(found);
      setMsg(found ? '' : t('deps.none', { tool: 'packer' }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    if (!hit) return;
    setBusy(true);
    setMsg(t('deps.installing', { id: hit.id, mgr: hit.manager }));
    try {
      const res = await installPackage(hit);
      setMsg(res.success ? t('deps.installed', { id: hit.id }) : res.stderr.trim() || `exit ${res.code}`);
      onDone();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
      <button className="mini primary" disabled={busy} onClick={() => void search()}>
        {t('deps.find')}
      </button>
      {hit && (
        <button className="mini" disabled={busy} onClick={() => void install()}>
          {t('deps.installVia', { mgr: hit.manager, id: hit.id })}
        </button>
      )}
      <button className="mini" onClick={onDone}>⟳ {t('deps.recheck')}</button>
      {msg && <span className="count-note">{msg}</span>}
    </div>
  );
}
