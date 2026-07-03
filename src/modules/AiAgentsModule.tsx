import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';

/**
 * AI Agents · AI 代理 — native port of WinForge's AiAgentsModule.
 * Live view of the six built-in terminal AI coding agents (Claude Code, OpenAI Codex,
 * opencode, Pi, OpenClaw, Hermes): detects install status, Node.js availability, per-agent
 * config-file existence and API-key env vars, then installs / launches / edits configs — all
 * against the real system through the Tauri Rust backend. Reuses WinForge's bilingual strings.
 */

type ConfigKind = 'json' | 'toml' | 'markdown' | 'text';

interface AiConfigFile {
  labelKey: string; // i18n key for the picker label
  /** Relative path under ~ (or ~/.config when useXdg). "/"-separated. */
  rel: string;
  kind: ConfigKind;
  useXdg?: boolean;
}

interface AiInstallMethod {
  labelKey: string; // 'aiagents.methodNpm' | 'aiagents.methodOfficial'
  /** PowerShell one-liner that performs the install. */
  script: string;
}

interface AiAgent {
  key: string;
  name: string;
  descKey: string;
  /** Command detected on PATH and launched, e.g. "claude". */
  cli: string;
  docsUrl: string;
  /** API-key env var name (User scope), or undefined. */
  envKey?: string;
  install: AiInstallMethod[];
  config: AiConfigFile[];
}

// Mirror of AiAgentService.All (six built-in agents). Names/URLs verbatim; descriptions via i18n.
const AGENTS: AiAgent[] = [
  {
    key: 'claude',
    name: 'Claude Code',
    descKey: 'aiagents.descClaude',
    cli: 'claude',
    docsUrl: 'https://code.claude.com/docs',
    envKey: 'ANTHROPIC_API_KEY',
    install: [
      { labelKey: 'aiagents.methodNpm', script: 'npm install -g @anthropic-ai/claude-code' },
      { labelKey: 'aiagents.methodOfficial', script: 'irm https://claude.ai/install.ps1 | iex' },
    ],
    config: [
      { labelKey: 'aiagents.fileClaudeSettings', rel: '.claude/settings.json', kind: 'json' },
      { labelKey: 'aiagents.fileClaudeMd', rel: '.claude/CLAUDE.md', kind: 'markdown' },
    ],
  },
  {
    key: 'codex',
    name: 'OpenAI Codex CLI',
    descKey: 'aiagents.descCodex',
    cli: 'codex',
    docsUrl: 'https://developers.openai.com/codex/cli',
    envKey: 'OPENAI_API_KEY',
    install: [{ labelKey: 'aiagents.methodNpm', script: 'npm install -g @openai/codex' }],
    config: [
      { labelKey: 'aiagents.fileCodexToml', rel: '.codex/config.toml', kind: 'toml' },
      { labelKey: 'aiagents.fileCodexAgents', rel: '.codex/AGENTS.md', kind: 'markdown' },
    ],
  },
  {
    key: 'opencode',
    name: 'opencode',
    descKey: 'aiagents.descOpencode',
    cli: 'opencode',
    docsUrl: 'https://opencode.ai/docs',
    install: [
      { labelKey: 'aiagents.methodNpm', script: 'npm install -g opencode-ai' },
      { labelKey: 'aiagents.methodOfficial', script: 'irm https://opencode.ai/install.ps1 | iex' },
    ],
    config: [
      { labelKey: 'aiagents.fileOpencodeJson', rel: 'opencode/opencode.json', kind: 'json', useXdg: true },
      { labelKey: 'aiagents.fileOpencodeAgents', rel: '.config/opencode/AGENTS.md', kind: 'markdown' },
    ],
  },
  {
    key: 'pi',
    name: 'Pi coding agent',
    descKey: 'aiagents.descPi',
    cli: 'pi',
    docsUrl: 'https://pi.dev',
    envKey: 'ANTHROPIC_API_KEY',
    install: [{ labelKey: 'aiagents.methodNpm', script: 'npm install -g @mariozechner/pi-coding-agent' }],
    config: [{ labelKey: 'aiagents.filePiConfig', rel: '.pi/config.json', kind: 'json' }],
  },
  {
    key: 'openclaw',
    name: 'OpenClaw',
    descKey: 'aiagents.descOpenclaw',
    cli: 'openclaw',
    docsUrl: 'https://docs.openclaw.ai',
    install: [{ labelKey: 'aiagents.methodNpm', script: 'npm install -g openclaw' }],
    config: [{ labelKey: 'aiagents.fileOpenclawConfig', rel: '.openclaw/config.json', kind: 'json' }],
  },
  {
    key: 'hermes',
    name: 'Hermes Agent',
    descKey: 'aiagents.descHermes',
    cli: 'hermes',
    docsUrl: 'https://hermes-agent.nousresearch.com/docs',
    install: [
      { labelKey: 'aiagents.methodOfficial', script: 'irm https://hermes-agent.nousresearch.com/install.ps1 | iex' },
    ],
    config: [{ labelKey: 'aiagents.fileHermesConfig', rel: '.hermes/config.json', kind: 'json' }],
  },
];

// ── Live probe shapes (populated from PowerShell) ─────────────────────────────
interface AgentProbe {
  Key: string;
  Installed: boolean;
  Version: string;
  KeySet: boolean; // API-key env var present (User or Process scope)
}

interface ConfigProbe {
  Rel: string; // agent.key + '|' + config.rel to key it uniquely
  Path: string;
  Exists: boolean;
}

interface EnvProbe {
  Node: boolean;
  NodeVersion: string;
  Wt: boolean; // Windows Terminal available
}

// PowerShell literal escaping (single-quoted strings). Doubles any embedded quote.
const ps = (s: string) => s.replace(/'/g, "''");

/** PowerShell expression for the base directory a config file is rooted at. */
function pathScript(useXdg: boolean | undefined): string {
  if (useXdg) {
    // XDG_CONFIG_HOME or ~/.config
    return `$(if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $env:USERPROFILE '.config' })`;
  }
  return '$env:USERPROFILE';
}

export function AiAgentsModule() {
  const { t } = useTranslation();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [workDir, setWorkDir] = useState('%USERPROFILE%');

  // ── Environment: Node.js + Windows Terminal ──
  const env = useAsync<EnvProbe>(async () => {
    const rows = await runPowershellJson<EnvProbe>(
      `$npm = (Get-Command npm -ErrorAction SilentlyContinue); ` +
        `$node = $null; if ($npm) { try { $node = (& npm --version 2>$null | Select-Object -First 1) } catch {} }; ` +
        `$wt = [bool](Get-Command wt.exe -ErrorAction SilentlyContinue); ` +
        `[pscustomobject]@{ Node = [bool]$npm; NodeVersion = ("" + $node).Trim(); Wt = $wt }`,
    );
    return rows[0] ?? { Node: false, NodeVersion: '', Wt: false };
  }, []);

  // ── Per-agent install / version / API-key detection ──
  const probes = useAsync<AgentProbe[]>(async () => {
    // One script that checks every agent CLI + env var, emits an array.
    const parts = AGENTS.map((a) => {
      const envCheck = a.envKey
        ? `[bool]([Environment]::GetEnvironmentVariable('${ps(a.envKey)}','User') -or [Environment]::GetEnvironmentVariable('${ps(a.envKey)}'))`
        : '$false';
      return (
        `$v=''; $ok=$false; ` +
        `$cmd = Get-Command '${ps(a.cli)}' -ErrorAction SilentlyContinue; ` +
        `if ($cmd) { $ok=$true; try { $v = (& '${ps(a.cli)}' --version 2>$null | Select-Object -First 1) } catch {} }; ` +
        `[pscustomobject]@{ Key='${ps(a.key)}'; Installed=$ok; Version=("" + $v).Trim(); KeySet=(${envCheck}) }`
      );
    });
    return runPowershellJson<AgentProbe>(parts.join('; '));
  }, []);

  // ── Per-config-file existence probe ──
  const configs = useAsync<ConfigProbe[]>(async () => {
    const parts: string[] = [];
    for (const a of AGENTS) {
      for (const f of a.config) {
        const base = pathScript(f.useXdg);
        const rel = f.rel.replace(/\//g, '\\');
        const idKey = `${a.key}|${f.rel}`;
        parts.push(
          `$p = Join-Path (${base}) '${ps(rel)}'; ` +
            `[pscustomobject]@{ Rel='${ps(idKey)}'; Path=$p; Exists=(Test-Path -LiteralPath $p) }`,
        );
      }
    }
    return runPowershellJson<ConfigProbe>(parts.join('; '));
  }, []);

  const probeByKey = useMemo(() => {
    const m = new Map<string, AgentProbe>();
    for (const p of probes.data ?? []) m.set(p.Key, p);
    return m;
  }, [probes.data]);

  const configByKey = useMemo(() => {
    const m = new Map<string, ConfigProbe>();
    for (const c of configs.data ?? []) m.set(c.Rel, c);
    return m;
  }, [configs.data]);

  const installedCount = useMemo(
    () => AGENTS.filter((a) => probeByKey.get(a.key)?.Installed).length,
    [probeByKey],
  );

  const reloadAll = useCallback(() => {
    env.reload();
    probes.reload();
    configs.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.reload, probes.reload, configs.reload]);

  const flash = (ok: boolean, text: string) => setMsg({ ok, text });

  const expandDir = (d: string) => d.replace(/%USERPROFILE%/gi, '$env:USERPROFILE');

  // ── Actions ──────────────────────────────────────────────────────────────
  const launch = async (a: AiAgent) => {
    setBusy(a.key);
    setMsg(null);
    try {
      const dir = workDir.trim();
      const dirScript = dir ? `-d "${expandDir(dir)}" ` : '';
      // wt.exe -d <dir> cmd /k <cli>; fall back to cmd /k in a new window.
      const script =
        `$dir = ${dir ? `"${expandDir(dir)}"` : '$null'}; ` +
        `if (Get-Command wt.exe -ErrorAction SilentlyContinue) { ` +
        `Start-Process wt.exe -ArgumentList '${dirScript}cmd /k ${ps(a.cli)}'; 'wt' } ` +
        `else { $psi = @{ FilePath='cmd.exe'; ArgumentList='/k ${ps(a.cli)}' }; ` +
        `if ($dir -and (Test-Path -LiteralPath $dir)) { $psi.WorkingDirectory = $dir }; ` +
        `Start-Process @psi; 'cmd' }`;
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      flash(true, t('aiagents.launched', { name: a.name }));
    } catch (e) {
      flash(false, `${t('aiagents.launchFailed', { name: a.name })}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const install = async (a: AiAgent, m: AiInstallMethod) => {
    setBusy(a.key);
    setMsg(null);
    try {
      const res = await runPowershell(m.script);
      if (!res.success) throw new Error(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
      flash(true, t('aiagents.installed', { name: a.name }));
      probes.reload();
    } catch (e) {
      flash(false, `${t('aiagents.installFailed', { name: a.name })}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const copyDocs = async (a: AiAgent) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(a.docsUrl);
      } else {
        await runPowershell(`Set-Clipboard -Value '${ps(a.docsUrl)}'`);
      }
      flash(true, t('aiagents.copied', { url: a.docsUrl }));
    } catch (e) {
      flash(false, String(e));
    }
  };

  const openConfigFolder = async (a: AiAgent) => {
    const f = a.config[0];
    if (!f) return;
    setBusy(a.key);
    try {
      const base = pathScript(f.useXdg);
      const rel = f.rel.replace(/\//g, '\\');
      const res = await runPowershell(
        `$p = Join-Path (${base}) '${ps(rel)}'; $d = Split-Path -Parent $p; ` +
          `if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }; ` +
          `Start-Process explorer.exe $d`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      flash(true, t('aiagents.openedFolder', { name: a.name }));
    } catch (e) {
      flash(false, String(e));
    } finally {
      setBusy(null);
    }
  };

  // ── Config editor state ──
  const [editorAgent, setEditorAgent] = useState<string | null>(null);
  const [editorFileRel, setEditorFileRel] = useState('');
  const [editorText, setEditorText] = useState('');
  const [editorPath, setEditorPath] = useState('');
  const [editorLoaded, setEditorLoaded] = useState(false);

  const openEditor = (a: AiAgent) => {
    const f = a.config[0];
    if (!f) return;
    setEditorAgent(a.key);
    setEditorFileRel(f.rel);
    setEditorText('');
    setEditorPath('');
    setEditorLoaded(false);
    void loadConfig(a, f);
  };

  const loadConfig = async (a: AiAgent, f: AiConfigFile) => {
    setBusy(`cfg:${a.key}`);
    try {
      const base = pathScript(f.useXdg);
      const rel = f.rel.replace(/\//g, '\\');
      const res = await runPowershell(
        `$p = Join-Path (${base}) '${ps(rel)}'; ` +
          `if (Test-Path -LiteralPath $p) { Get-Content -LiteralPath $p -Raw -Encoding UTF8 } else { '' }`,
      );
      const p = await runPowershell(`Join-Path (${base}) '${ps(rel)}'`);
      setEditorPath(p.stdout.trim());
      setEditorText(res.stdout.replace(/\r\n/g, '\n').replace(/\n$/, ''));
      setEditorLoaded(true);
    } catch (e) {
      flash(false, String(e));
    } finally {
      setBusy(null);
    }
  };

  const selectEditorFile = (a: AiAgent, rel: string) => {
    const f = a.config.find((c) => c.rel === rel);
    if (!f) return;
    setEditorFileRel(rel);
    setEditorText('');
    setEditorLoaded(false);
    void loadConfig(a, f);
  };

  const saveConfig = async () => {
    const a = AGENTS.find((x) => x.key === editorAgent);
    const f = a?.config.find((c) => c.rel === editorFileRel);
    if (!a || !f) return;
    // JSON validation before overwrite (matches WinForge — warn + block).
    if (f.kind === 'json' && editorText.trim()) {
      try {
        JSON.parse(editorText);
      } catch (e) {
        flash(false, `${t('aiagents.invalidJson')}: ${String(e)}`);
        return;
      }
    }
    setBusy(`cfg:${a.key}`);
    try {
      const base = pathScript(f.useXdg);
      const rel = f.rel.replace(/\//g, '\\');
      // Base64 the body so arbitrary content survives shell quoting intact.
      const b64 = btoa(unescape(encodeURIComponent(editorText)));
      const res = await runPowershell(
        `$p = Join-Path (${base}) '${ps(rel)}'; $d = Split-Path -Parent $p; ` +
          `if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }; ` +
          `$bytes = [Convert]::FromBase64String('${b64}'); ` +
          `[System.IO.File]::WriteAllBytes($p, $bytes); 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      flash(true, t('aiagents.savedConfig', { name: a.name }));
      configs.reload();
    } catch (e) {
      flash(false, `${t('aiagents.saveFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // ── API key ──
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const saveKey = async (a: AiAgent) => {
    if (!a.envKey) return;
    const value = keyDraft[a.key] ?? '';
    setBusy(`key:${a.key}`);
    try {
      const res = await runPowershell(
        `[Environment]::SetEnvironmentVariable('${ps(a.envKey)}', '${ps(value)}', 'User'); 'ok'`,
      );
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      flash(true, t('aiagents.savedKey', { name: a.name }));
      probes.reload();
    } catch (e) {
      flash(false, `${t('aiagents.keyFailed')}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const browseWorkDir = async () => {
    // Best-effort folder picker via PowerShell WinForms dialog; falls back silently.
    try {
      const res = await runCommand('powershell', [
        '-NoProfile',
        '-STA',
        '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
      ]);
      const picked = res.stdout.trim();
      if (picked) setWorkDir(picked);
    } catch {
      /* no-op in browser */
    }
  };

  // ── Agent table columns ──
  const columns: Column<AiAgent>[] = [
    {
      key: 'status',
      header: t('aiagents.colStatus'),
      width: 120,
      render: (a) => {
        const p = probeByKey.get(a.key);
        const installed = !!p?.Installed;
        return <StatusDot ok={installed} label={installed ? t('aiagents.installed') : t('aiagents.notInstalled')} />;
      },
    },
    {
      key: 'name',
      header: t('aiagents.colAgent'),
      render: (a) => {
        const p = probeByKey.get(a.key);
        return (
          <div>
            <div style={{ fontWeight: 600 }}>{a.name}</div>
            <div className="count-note" style={{ marginTop: 2 }}>{t(a.descKey)}</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.7, marginTop: 2 }}>
              {a.cli}
              {p?.Version ? ` · ${p.Version}` : ''}
            </div>
          </div>
        );
      },
    },
    {
      key: 'key',
      header: t('aiagents.colApiKey'),
      width: 130,
      render: (a) =>
        a.envKey ? (
          <StatusDot
            ok={!!probeByKey.get(a.key)?.KeySet}
            label={probeByKey.get(a.key)?.KeySet ? t('aiagents.keySet') : t('aiagents.keyUnset')}
          />
        ) : (
          <span className="count-note">{t('aiagents.noKeyNeeded')}</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      width: 320,
      render: (a) => {
        const busyThis = busy === a.key;
        return (
          <span className="row-actions" style={{ flexWrap: 'wrap' }}>
            <button
              className="mini primary"
              disabled={busyThis || !probeByKey.get(a.key)?.Installed}
              onClick={() => launch(a)}
            >
              {t('aiagents.launch')}
            </button>
            {a.install.map((m) => (
              <button key={m.labelKey} className="mini" disabled={busyThis} onClick={() => install(a, m)}>
                {t('aiagents.installVia', { method: t(m.labelKey) })}
              </button>
            ))}
            <button className="mini" disabled={busyThis} onClick={() => openEditor(a)}>
              {t('aiagents.config')}
            </button>
            <button className="mini" disabled={busyThis} onClick={() => openConfigFolder(a)}>
              {t('aiagents.openFolder')}
            </button>
            <button className="mini" onClick={() => copyDocs(a)}>
              {t('aiagents.copyDocs')}
            </button>
          </span>
        );
      },
    },
  ];

  const editorAgentObj = AGENTS.find((a) => a.key === editorAgent);

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('aiagents.blurb')}
      </p>

      {/* ── Environment status ── */}
      <ModuleToolbar>
        <button className="mini" onClick={reloadAll} disabled={env.loading || probes.loading}>
          ⟳ {t('modules.refresh')}
        </button>
        {env.data && (
          <StatusDot
            ok={env.data.Node}
            label={env.data.Node ? t('aiagents.nodeFound', { version: env.data.NodeVersion || '?' }) : t('aiagents.nodeMissing')}
          />
        )}
        {env.data && (
          <StatusDot ok={env.data.Wt} label={env.data.Wt ? t('aiagents.wtFound') : t('aiagents.wtMissing')} />
        )}
        <span className="count-note">{t('aiagents.installedCount', { num: installedCount, total: AGENTS.length })}</span>
      </ModuleToolbar>

      {env.data && !env.data.Node && <p className="mod-msg">{t('aiagents.nodeHint')}</p>}

      {/* ── Launch working folder ── */}
      <section className="hosts-edit" style={{ marginTop: 12 }}>
        <label className="count-note">{t('aiagents.workDirLabel')}</label>
        <div className="mod-toolbar">
          <input
            className="mod-search"
            style={{ flex: 1, fontFamily: 'monospace' }}
            value={workDir}
            onChange={(e) => setWorkDir(e.target.value)}
            placeholder="%USERPROFILE%"
          />
          <button className="mini" onClick={browseWorkDir}>
            {t('aiagents.browse')}
          </button>
        </div>
      </section>

      {msg && (
        <p className="mod-msg" style={msg.ok ? undefined : { color: 'var(--err, #d33)' }}>
          {msg.text}
        </p>
      )}

      {/* ── Agent table ── */}
      <section style={{ marginTop: 12 }}>
        <AsyncState loading={probes.loading} error={probes.error}>
          <DataTable columns={columns} rows={AGENTS} rowKey={(a) => a.key} />
        </AsyncState>
      </section>

      {/* ── Config editor ── */}
      {editorAgentObj && (
        <section className="hosts-edit" style={{ marginTop: 16 }}>
          <div className="mod-toolbar">
            <h3 style={{ flex: 1, margin: 0 }}>{t('aiagents.configFor', { name: editorAgentObj.name })}</h3>
            <button className="mini" onClick={() => setEditorAgent(null)}>
              {t('aiagents.closeEditor')}
            </button>
          </div>
          <p className="count-note" style={{ marginTop: 0 }}>{t('aiagents.configNote')}</p>
          <div className="mod-toolbar">
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t('aiagents.file')}
              <select
                className="mod-search"
                value={editorFileRel}
                onChange={(e) => selectEditorFile(editorAgentObj, e.target.value)}
              >
                {editorAgentObj.config.map((f) => (
                  <option key={f.rel} value={f.rel}>
                    {t(f.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="mini"
              disabled={busy === `cfg:${editorAgentObj.key}`}
              onClick={() => {
                const f = editorAgentObj.config.find((c) => c.rel === editorFileRel);
                if (f) void loadConfig(editorAgentObj, f);
              }}
            >
              {t('aiagents.reloadConfig')}
            </button>
            <button
              className="mini primary"
              disabled={busy === `cfg:${editorAgentObj.key}` || !editorLoaded}
              onClick={saveConfig}
            >
              {t('aiagents.save')}
            </button>
          </div>
          {editorPath && (
            <p className="count-note" style={{ marginTop: 0, fontFamily: 'monospace' }}>
              {editorPath}
              {'  '}
              {(() => {
                const c = configByKey.get(`${editorAgentObj.key}|${editorFileRel}`);
                return c ? (c.Exists ? t('aiagents.fileExists') : t('aiagents.fileNew')) : '';
              })()}
            </p>
          )}
          <textarea
            className="hosts-edit"
            spellCheck={false}
            style={{ width: '100%', minHeight: 240, fontFamily: 'monospace', fontSize: 13 }}
            value={editorText}
            onChange={(e) => setEditorText(e.target.value)}
            placeholder={t('aiagents.editorPlaceholder')}
          />

          {/* API key row for this agent */}
          {editorAgentObj.envKey && (
            <div className="mod-toolbar" style={{ marginTop: 8 }}>
              <label className="count-note" style={{ fontFamily: 'monospace' }}>{editorAgentObj.envKey}</label>
              <input
                className="mod-search"
                type="password"
                style={{ flex: 1 }}
                value={keyDraft[editorAgentObj.key] ?? ''}
                onChange={(e) => setKeyDraft((d) => ({ ...d, [editorAgentObj.key]: e.target.value }))}
                placeholder={`${editorAgentObj.envKey}…`}
              />
              <button
                className="mini"
                disabled={busy === `key:${editorAgentObj.key}`}
                onClick={() => saveKey(editorAgentObj)}
              >
                {t('aiagents.saveKey')}
              </button>
            </div>
          )}
        </section>
      )}

      <p className="count-note" style={{ marginTop: 16 }}>{t('aiagents.safetyNote')}</p>
    </div>
  );
}
