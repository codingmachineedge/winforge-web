import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, isTauri, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

/**
 * quicktype · JSON 轉型別 — paste JSON / JSON Schema / TypeScript / GraphQL / Postman, pick a target
 * language and generate typed source via the quicktype npm CLI. Faithful port of WinForge's QuickTypeModule:
 * writes the input to a temp file, invokes the CLI with the chosen options, shows stdout with Copy + Save.
 */

interface InputKind {
  key: string;
  srcLang: string;
  label: string;
  ext: string;
}

interface TargetLang {
  key: string;
  lang: string;
  label: string;
  fileExt: string;
}

const INPUT_KINDS: InputKind[] = [
  { key: 'json', srcLang: 'json', label: 'JSON', ext: '.json' },
  { key: 'schema', srcLang: 'schema', label: 'JSON Schema', ext: '.json' },
  { key: 'typescript', srcLang: 'typescript', label: 'TypeScript', ext: '.ts' },
  { key: 'graphql', srcLang: 'graphql', label: 'GraphQL schema', ext: '.graphql' },
  { key: 'postman', srcLang: 'postman', label: 'Postman collection', ext: '.json' },
];

const TARGETS: TargetLang[] = [
  { key: 'cs', lang: 'csharp', label: 'C#', fileExt: '.cs' },
  { key: 'ts', lang: 'typescript', label: 'TypeScript', fileExt: '.ts' },
  { key: 'tse', lang: 'typescript-effect-schema', label: 'TypeScript (effect Schema)', fileExt: '.ts' },
  { key: 'tszod', lang: 'typescript-zod', label: 'TypeScript (Zod)', fileExt: '.ts' },
  { key: 'py', lang: 'python', label: 'Python', fileExt: '.py' },
  { key: 'go', lang: 'go', label: 'Go', fileExt: '.go' },
  { key: 'rust', lang: 'rust', label: 'Rust', fileExt: '.rs' },
  { key: 'java', lang: 'java', label: 'Java', fileExt: '.java' },
  { key: 'kotlin', lang: 'kotlin', label: 'Kotlin', fileExt: '.kt' },
  { key: 'swift', lang: 'swift', label: 'Swift', fileExt: '.swift' },
  { key: 'objc', lang: 'objective-c', label: 'Objective-C', fileExt: '.m' },
  { key: 'cpp', lang: 'c++', label: 'C++', fileExt: '.hpp' },
  { key: 'dart', lang: 'dart', label: 'Dart', fileExt: '.dart' },
  { key: 'ruby', lang: 'ruby', label: 'Ruby', fileExt: '.rb' },
  { key: 'elm', lang: 'elm', label: 'Elm', fileExt: '.elm' },
  { key: 'php', lang: 'php', label: 'PHP', fileExt: '.php' },
  { key: 'scala3', lang: 'scala3', label: 'Scala 3', fileExt: '.scala' },
  { key: 'haskell', lang: 'haskell', label: 'Haskell', fileExt: '.hs' },
  { key: 'js', lang: 'javascript', label: 'JavaScript', fileExt: '.js' },
  { key: 'jsonschema', lang: 'json-schema', label: 'JSON Schema', fileExt: '.json' },
  { key: 'proto', lang: 'proto', label: 'Protobuf', fileExt: '.proto' },
  { key: 'crystal', lang: 'crystal', label: 'Crystal', fileExt: '.cr' },
];

const FRAMEWORKS: { value: string; label: string }[] = [
  { value: 'SystemTextJson', label: 'System.Text.Json' },
  { value: 'NewtonSoft', label: 'Newtonsoft.Json' },
];

const SAMPLE_JSON = `{
  "id": 42,
  "name": "Ada Lovelace",
  "active": true,
  "tags": ["math", "code"],
  "profile": { "city": "London", "score": 9.5 }
}
`;

export function QuicktypeModule() {
  const { t } = useTranslation();

  const [inputKindKey, setInputKindKey] = useState<string>(INPUT_KINDS[0]!.key);
  const [targetKey, setTargetKey] = useState<string>(TARGETS[0]!.key);
  const [source, setSource] = useState<string>(SAMPLE_JSON);
  const [topLevel, setTopLevel] = useState<string>('Root');
  const [justTypes, setJustTypes] = useState<boolean>(false);
  const [namespace, setNamespace] = useState<string>('');
  const [framework, setFramework] = useState<string>(FRAMEWORKS[0]!.value);
  const [listArray, setListArray] = useState<boolean>(false);

  const [output, setOutput] = useState<string>('');
  const [cmdLine, setCmdLine] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const inputKind = INPUT_KINDS.find((k) => k.key === inputKindKey) ?? INPUT_KINDS[0]!;
  const target = TARGETS.find((tg) => tg.key === targetKey) ?? TARGETS[0]!;
  const isCSharp = target.lang === 'csharp';

  // Build the quicktype argument list from the current options (input file positional appended by caller).
  const buildArgs = (inPath: string): string[] => {
    const args: string[] = [];
    args.push('--src-lang', inputKind.srcLang);
    args.push('--lang', target.lang);
    const topName = topLevel.trim() === '' ? 'Root' : topLevel.trim();
    args.push('--top-level', topName);
    if (justTypes) args.push('--just-types');
    if (isCSharp) {
      if (namespace.trim() !== '') args.push('--namespace', namespace.trim());
      if (framework !== '') args.push('--framework', framework);
      if (listArray) args.push('--array-type', 'list');
    }
    args.push(inPath);
    return args;
  };

  // Preview command line (no temp path — uses a friendly placeholder).
  const previewCmd = (): string => {
    const parts = buildArgs('<input' + inputKind.ext + '>');
    return 'quicktype ' + parts.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
  };

  const clearInput = () => {
    setSource('');
    setError('');
    setNote('');
  };

  const loadSample = () => {
    setSource(SAMPLE_JSON);
    setInputKindKey('json');
    setNote(t('quicktype.sampleLoaded'));
  };

  // Write the source to a temp file via PowerShell (base64 to survive any content), returning its path.
  const writeTempInput = async (): Promise<string> => {
    const b64 = btoa(unescape(encodeURIComponent(source)));
    const script =
      `$d = Join-Path $env:TEMP 'WinForge-quicktype'; ` +
      `New-Item -ItemType Directory -Force -Path $d | Out-Null; ` +
      `$p = Join-Path $d ('input_' + [guid]::NewGuid().ToString('N') + '${inputKind.ext}'); ` +
      `$bytes = [Convert]::FromBase64String('${b64}'); ` +
      `[System.IO.File]::WriteAllBytes($p, $bytes); ` +
      `Write-Output $p`;
    const res: CommandOutput = await runPowershell(script);
    const path = (res.stdout || '').trim();
    if (!path) throw new Error(res.stderr.trim() || t('quicktype.tempFailed'));
    return path;
  };

  const deleteTemp = async (path: string) => {
    try {
      await runPowershell(`Remove-Item -LiteralPath '${path.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`);
    } catch {
      /* ignore cleanup failures */
    }
  };

  const generate = async (quicktypePath: string) => {
    if (busy) return;
    setError('');
    setNote('');
    if (source.trim() === '') {
      setNote(t('quicktype.nothingToGenerate'));
      return;
    }
    if (!isTauri()) {
      setNote(t('quicktype.needsDesktop'));
      return;
    }
    setBusy(true);
    setOutput('');
    let tempPath = '';
    try {
      tempPath = await writeTempInput();
      const args = buildArgs(tempPath);
      setCmdLine('quicktype ' + args.slice(0, -1).map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ') + ' <input>');
      const res: CommandOutput = await runCommand(quicktypePath, args);
      if (res.success) {
        setOutput((res.stdout || '').trimEnd() + '\n');
        setNote(t('quicktype.generated', { lang: target.label }));
      } else {
        setError((res.stderr || res.stdout || '').trim() || t('quicktype.genFailed'));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (tempPath) await deleteTemp(tempPath);
      setBusy(false);
    }
  };

  const copyOutput = async () => {
    if (output === '') return;
    try {
      await navigator.clipboard.writeText(output);
      setNote(t('quicktype.copied'));
    } catch {
      setNote(t('quicktype.copyFailed'));
    }
  };

  // Save output to a file the user picks (via PowerShell SaveFileDialog in the desktop app).
  const saveOutput = async () => {
    if (output === '') return;
    if (!isTauri()) {
      setNote(t('quicktype.needsDesktop'));
      return;
    }
    const base = topLevel.trim() === '' ? 'Generated' : topLevel.trim();
    const suggested = base + target.fileExt;
    const b64 = btoa(unescape(encodeURIComponent(output)));
    const script =
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `$dlg = New-Object System.Windows.Forms.SaveFileDialog; ` +
      `$dlg.FileName = '${suggested.replace(/'/g, "''")}'; ` +
      `$dlg.Filter = 'All files (*.*)|*.*'; ` +
      `if ($dlg.ShowDialog() -eq 'OK') { ` +
      `$bytes = [Convert]::FromBase64String('${b64}'); ` +
      `[System.IO.File]::WriteAllBytes($dlg.FileName, $bytes); ` +
      `Write-Output $dlg.FileName }`;
    try {
      const res: CommandOutput = await runPowershell(script);
      const saved = (res.stdout || '').trim();
      if (saved) setNote(t('quicktype.saved', { path: saved }));
      else if (!res.success) setError(res.stderr.trim() || t('quicktype.saveFailed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('quicktype.intro')}
      </p>

      <DependencyGate tool="quicktype" query="quicktype">
        {(path) => (
          <>
            {!isTauri() && <p className="count-note">{t('quicktype.needsDesktop')}</p>}

            <div className="io-grid">
              <div className="panel">
                <div className="mod-toolbar">
                  <strong className="label">{t('quicktype.input')}</strong>
                  <button className="mini" onClick={loadSample} disabled={busy}>
                    {t('quicktype.loadSample')}
                  </button>
                  <button className="mini" onClick={clearInput} disabled={busy}>
                    {t('quicktype.clear')}
                  </button>
                </div>

                <div className="kv-row">
                  <span className="label">{t('quicktype.inputKind')}</span>
                  <select
                    className="mod-select"
                    value={inputKindKey}
                    onChange={(e) => setInputKindKey(e.target.value)}
                    disabled={busy}
                  >
                    {INPUT_KINDS.map((k) => (
                      <option key={k.key} value={k.key}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </div>

                <textarea
                  className="hosts-edit"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder={t('quicktype.inputPlaceholder')}
                  spellCheck={false}
                  rows={12}
                  disabled={busy}
                />
              </div>

              <div className="panel">
                <strong className="label">{t('quicktype.options')}</strong>

                <div className="kv-list">
                  <div className="kv-row">
                    <span className="label">{t('quicktype.targetLang')}</span>
                    <select
                      className="mod-select"
                      value={targetKey}
                      onChange={(e) => setTargetKey(e.target.value)}
                      disabled={busy}
                    >
                      {TARGETS.map((tg) => (
                        <option key={tg.key} value={tg.key}>
                          {tg.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="kv-row">
                    <span className="label">{t('quicktype.topLevel')}</span>
                    <input
                      className="mod-search"
                      value={topLevel}
                      onChange={(e) => setTopLevel(e.target.value)}
                      placeholder="Root"
                      disabled={busy}
                    />
                  </div>

                  <label className="chk">
                    <input
                      type="checkbox"
                      checked={justTypes}
                      onChange={(e) => setJustTypes(e.target.checked)}
                      disabled={busy}
                    />
                    {t('quicktype.justTypes')}
                  </label>

                  {isCSharp && (
                    <>
                      <div className="kv-row">
                        <span className="label">{t('quicktype.namespace')}</span>
                        <input
                          className="mod-search"
                          value={namespace}
                          onChange={(e) => setNamespace(e.target.value)}
                          placeholder="MyApp.Models"
                          disabled={busy}
                        />
                      </div>

                      <div className="kv-row">
                        <span className="label">{t('quicktype.framework')}</span>
                        <select
                          className="mod-select"
                          value={framework}
                          onChange={(e) => setFramework(e.target.value)}
                          disabled={busy}
                        >
                          {FRAMEWORKS.map((f) => (
                            <option key={f.value} value={f.value}>
                              {f.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <label className="chk">
                        <input
                          type="checkbox"
                          checked={listArray}
                          onChange={(e) => setListArray(e.target.checked)}
                          disabled={busy}
                        />
                        {t('quicktype.listArray')}
                      </label>
                    </>
                  )}
                </div>

                <div className="mod-toolbar">
                  <button className="mini primary" onClick={() => generate(path)} disabled={busy}>
                    {busy ? t('quicktype.generating') : t('quicktype.generate')}
                  </button>
                </div>

                <p className="count-note" style={{ marginTop: 0 }}>
                  <code>{previewCmd()}</code>
                </p>
              </div>
            </div>

            <div className="panel">
              <div className="mod-toolbar">
                <strong className="label">{t('quicktype.output')}</strong>
                <button className="mini" onClick={copyOutput} disabled={output === ''}>
                  {t('quicktype.copy')}
                </button>
                <button className="mini" onClick={saveOutput} disabled={output === ''}>
                  {t('quicktype.save')}
                </button>
              </div>

              {note && <p className="count-note">{note}</p>}
              {error && <p className="error">{error}</p>}
              {cmdLine && !error && (
                <p className="count-note" style={{ marginTop: 0 }}>
                  <code>{cmdLine}</code>
                </p>
              )}
              {output ? (
                <pre className="cmd-out">{output}</pre>
              ) : (
                <p className="count-note">{t('quicktype.noOutput')}</p>
              )}
            </div>
          </>
        )}
      </DependencyGate>
    </div>
  );
}
