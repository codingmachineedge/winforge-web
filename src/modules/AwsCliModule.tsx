import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { DependencyGate } from './DependencyGate';

/** One profile summary parsed from ~/.aws/{config,credentials}. Never carries the secret key. */
interface AwsProfile {
  Name: string;
  Region: string;
  Output: string;
  HasCredentials: boolean;
  IsSso: boolean;
}

const OUTPUT_FORMATS = ['json', 'text', 'table', 'yaml', 'yaml-stream'];

const ALL_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'af-south-1',
  'ap-east-1', 'ap-south-1', 'ap-south-2',
  'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
  'ca-central-1', 'ca-west-1',
  'eu-central-1', 'eu-central-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3',
  'eu-north-1', 'eu-south-1', 'eu-south-2',
  'il-central-1',
  'me-central-1', 'me-south-1',
  'sa-east-1',
  'us-gov-east-1', 'us-gov-west-1',
  'cn-north-1', 'cn-northwest-1',
];

// PowerShell that parses both ~/.aws/config and ~/.aws/credentials and emits one object per profile.
// Read-only; only reports whether an access-key id exists — never the secret value.
const PROFILES_PS = String.raw`
$dir = Join-Path $env:USERPROFILE '.aws'
$cfg = Join-Path $dir 'config'
$cred = Join-Path $dir 'credentials'
$map = @{}
function Parse-Ini($path, [scriptblock]$onSection) {
  if (-not (Test-Path $path)) { return }
  $section = $null; $kv = @{}
  foreach ($raw in (Get-Content -LiteralPath $path)) {
    $line = $raw.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#') -or $line.StartsWith(';')) { continue }
    if ($line.StartsWith('[') -and $line.EndsWith(']')) {
      if ($section) { & $onSection $section $kv }
      $section = $line.Substring(1, $line.Length - 2).Trim(); $kv = @{}
    } elseif ($section) {
      $eq = $line.IndexOf('=')
      if ($eq -gt 0) { $kv[$line.Substring(0,$eq).Trim().ToLower()] = $line.Substring($eq+1).Trim() }
    }
  }
  if ($section) { & $onSection $section $kv }
}
Parse-Ini $cfg {
  param($s,$kv)
  $name = if ($s -like 'profile *') { $s.Substring(8).Trim() } else { $s.Trim() }
  if ($name -eq '' -or $s -like 'sso-session*' -or $s -like 'services*') { return }
  $sso = $false; foreach ($k in $kv.Keys) { if ($k -like 'sso_*') { $sso = $true } }
  $map[$name] = [pscustomobject]@{ Name=$name; Region=[string]$kv['region']; Output=[string]$kv['output']; HasCredentials=$false; IsSso=$sso }
}
Parse-Ini $cred {
  param($s,$kv)
  $name = $s.Trim(); if ($name -eq '') { return }
  $hasKey = $kv.ContainsKey('aws_access_key_id')
  if ($map.ContainsKey($name)) { $map[$name].HasCredentials = $map[$name].HasCredentials -or $hasKey }
  else { $map[$name] = [pscustomobject]@{ Name=$name; Region=''; Output=''; HasCredentials=$hasKey; IsSso=$false } }
}
$map.Values | Sort-Object Name
`;

interface PanelAction {
  label: string;
  args: string;
  destructive?: boolean;
  /** When set, prompt the user for a value and substitute {v} in `args`. */
  prompt?: string;
}

const H_STYLE: CSSProperties = { fontSize: 14, fontWeight: 600, margin: '14px 0 2px' };

export function AwsCliModule() {
  return (
    <div className="mod">
      <DependencyGate tool="aws" preferId="Amazon.AWSCLI" query="aws-cli">
        {(path) => <AwsInner awsPath={path} />}
      </DependencyGate>
    </div>
  );
}

function AwsInner({ awsPath }: { awsPath: string }) {
  const { t } = useTranslation();

  const [profile, setProfile] = useState('');
  const [region, setRegion] = useState('');
  const [output, setOutput] = useState('json');

  const [raw, setRaw] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);

  const version = useAsync(async () => {
    const res = await runCommand(awsPath, ['--version']);
    return (res.stdout || res.stderr || '').trim();
  }, [awsPath]);

  const profiles = useAsync(() => runPowershellJson<AwsProfile>(PROFILES_PS), []);

  // Split a raw "s3 ls s3://x" string into argv, honouring double quotes.
  const toArgs = (s: string): string[] => {
    const parts = s.match(/"[^"]*"|\S+/g) ?? [];
    return parts.map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p));
  };

  // Append active profile/region/output unless the command already sets them.
  const decorate = (argv: string[]): string[] => {
    const flags = argv.join(' ');
    const extra: string[] = [];
    if (profile && !flags.includes('--profile')) extra.push('--profile', profile);
    if (region && !flags.includes('--region')) extra.push('--region', region);
    if (output && !flags.includes('--output')) extra.push('--output', output);
    return [...argv, ...extra];
  };

  const pushHistory = (cmd: string) => {
    setHistory((h) => [cmd, ...h.filter((c) => c !== cmd)].slice(0, 50));
  };

  const runAws = async (argsStr: string, record = true) => {
    let s = argsStr.trim();
    if (s.toLowerCase().startsWith('aws ')) s = s.slice(4).trim();
    if (!s) return;
    const argv = decorate(toArgs(s));
    setBusy(true);
    setOut(`$ aws ${argv.join(' ')}\n`);
    if (record) pushHistory(s);
    try {
      const res = await runCommand(awsPath, argv);
      const body = res.stdout || res.stderr || t('aws.noOutput');
      setOut(`$ aws ${argv.join(' ')}\n\n${body}\n\n${t('aws.exit', { code: res.code })}`);
    } catch (e) {
      setOut(`$ aws ${argv.join(' ')}\n\n${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const runPanel = async (a: PanelAction) => {
    let args = a.args;
    if (a.prompt) {
      const v = window.prompt(a.prompt);
      if (v == null || !v.trim()) return;
      args = args.replace('{v}', v.trim());
    }
    if (a.destructive) {
      if (!window.confirm(t('aws.confirmDestructive', { cmd: `aws ${args}` }))) return;
    }
    await runAws(args);
  };

  const toggleFavorite = () => {
    let s = raw.trim();
    if (s.toLowerCase().startsWith('aws ')) s = s.slice(4).trim();
    if (!s) return;
    setFavorites((f) => (f.includes(s) ? f.filter((c) => c !== s) : [s, ...f]));
  };

  const copyOut = async () => {
    try {
      await navigator.clipboard.writeText(out);
    } catch {
      /* clipboard unavailable in this context */
    }
  };

  const profileRows = useMemo(() => profiles.data ?? [], [profiles.data]);

  const profileColumns: Column<AwsProfile>[] = [
    { key: 'Name', header: t('aws.profileName') },
    {
      key: 'creds',
      header: t('aws.credentials'),
      width: 130,
      render: (p) => (
        <StatusDot ok={p.HasCredentials || p.IsSso} label={p.IsSso ? 'SSO' : p.HasCredentials ? t('aws.keys') : t('aws.none')} />
      ),
    },
    { key: 'Region', header: t('aws.region'), width: 130, render: (p) => p.Region || '—' },
    { key: 'Output', header: t('aws.output'), width: 100, render: (p) => p.Output || '—' },
    {
      key: 'actions',
      header: '',
      width: 120,
      render: (p) => (
        <button className="mini" onClick={() => { setProfile(p.Name); if (p.Region) setRegion(p.Region); }}>
          {t('aws.use')}
        </button>
      ),
    },
  ];

  const panels: { title: string; actions: PanelAction[] }[] = [
    {
      title: t('aws.panelS3'),
      actions: [
        { label: t('aws.s3ListBuckets'), args: 's3 ls' },
        { label: t('aws.s3ListObjects'), args: 's3 ls s3://{v} --recursive', prompt: t('aws.promptBucketPrefix') },
        { label: t('aws.s3MakeBucket'), args: 's3 mb s3://{v}', prompt: t('aws.promptNewBucket') },
        { label: t('aws.s3RemoveBucket'), args: 's3 rb s3://{v}', prompt: t('aws.promptBucketEmpty'), destructive: true },
      ],
    },
    {
      title: t('aws.panelEc2'),
      actions: [
        { label: t('aws.ec2Describe'), args: 'ec2 describe-instances --output table' },
        { label: t('aws.ec2Start'), args: 'ec2 start-instances --instance-ids {v}', prompt: t('aws.promptInstanceId') },
        { label: t('aws.ec2Stop'), args: 'ec2 stop-instances --instance-ids {v}', prompt: t('aws.promptInstanceId') },
        { label: t('aws.ec2Reboot'), args: 'ec2 reboot-instances --instance-ids {v}', prompt: t('aws.promptInstanceId') },
        { label: t('aws.ec2Terminate'), args: 'ec2 terminate-instances --instance-ids {v}', prompt: t('aws.promptInstanceId'), destructive: true },
      ],
    },
    {
      title: t('aws.panelIam'),
      actions: [
        { label: t('aws.iamUsers'), args: 'iam list-users --output table' },
        { label: t('aws.iamRoles'), args: 'iam list-roles --output table' },
        { label: t('aws.iamGroups'), args: 'iam list-groups --output table' },
        { label: t('aws.iamPolicies'), args: 'iam list-policies --scope Local --output table' },
      ],
    },
    {
      title: t('aws.panelLambda'),
      actions: [
        { label: t('aws.lambdaList'), args: 'lambda list-functions --output table' },
      ],
    },
    {
      title: t('aws.panelLogs'),
      actions: [
        { label: t('aws.logsGroups'), args: 'logs describe-log-groups --output table' },
      ],
    },
  ];

  return (
    <>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('aws.blurb')}
      </p>
      {version.data && (
        <p className="count-note" style={{ marginTop: 0 }}>
          <StatusDot ok label={version.data} />
        </p>
      )}

      {/* Context: profile / region / output */}
      <h4 style={H_STYLE}>{t('aws.context')}</h4>
      <ModuleToolbar>
        <label className="count-note">{t('aws.profile')}</label>
        <select className="mod-search" value={profile} onChange={(e) => setProfile(e.target.value)}>
          <option value="">{t('aws.defaultNone')}</option>
          {profileRows.map((p) => (
            <option key={p.Name} value={p.Name}>
              {p.Name}
              {p.IsSso ? ' · SSO' : p.HasCredentials ? ' · keys' : ''}
            </option>
          ))}
        </select>
        <label className="count-note">{t('aws.region')}</label>
        <select className="mod-search" value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="">{t('aws.defaultNone')}</option>
          {ALL_REGIONS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <label className="count-note">{t('aws.output')}</label>
        <select className="mod-search" value={output} onChange={(e) => setOutput(e.target.value)}>
          {OUTPUT_FORMATS.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
        <button className="mini" disabled={busy} onClick={() => runAws('sts get-caller-identity')}>
          {t('aws.whoAmI')}
        </button>
        <button className="mini" onClick={profiles.reload}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>

      <AsyncState loading={profiles.loading} error={profiles.error}>
        <DataTable columns={profileColumns} rows={profileRows} rowKey={(p) => p.Name} empty={t('aws.noProfiles')} />
      </AsyncState>

      {/* Raw command runner */}
      <h4 style={H_STYLE}>{t('aws.rawCommand')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('aws.rawHint')}
      </p>
      <div className="mod-form">
        <span className="count-note" style={{ fontFamily: 'monospace', fontWeight: 600 }}>aws</span>
        <input
          className="mod-search"
          placeholder="s3 ls   ·   ec2 describe-instances   ·   sts get-caller-identity"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runAws(raw)}
        />
        <button className="mini primary" disabled={busy} onClick={() => runAws(raw)}>
          {busy ? t('aws.running') : t('aws.run')}
        </button>
        <button className="mini" onClick={toggleFavorite}>★ {t('aws.favorite')}</button>
        <button className="mini" disabled={!out} onClick={copyOut}>{t('aws.copy')}</button>
        <button className="mini" disabled={!out} onClick={() => setOut('')}>{t('aws.clear')}</button>
      </div>
      {out && <pre className="cmd-out">{out}</pre>}

      {/* History & favorites */}
      {(history.length > 0 || favorites.length > 0) && (
        <>
          <h4 style={H_STYLE}>{t('aws.historyFav')}</h4>
          {favorites.length > 0 && (
            <div className="mod-toolbar">
              <span className="count-note">{t('aws.favorites')}</span>
              {favorites.map((f) => (
                <button key={f} className="mini" title={`aws ${f}`} onClick={() => { setRaw(f); runAws(f); }}>
                  aws {f}
                </button>
              ))}
            </div>
          )}
          {history.length > 0 && (
            <div className="mod-toolbar">
              <span className="count-note">{t('aws.history')}</span>
              {history.map((h, i) => (
                <button key={`${h}-${i}`} className="mini" title={`aws ${h}`} onClick={() => { setRaw(h); runAws(h, false); }}>
                  aws {h}
                </button>
              ))}
              <button className="mini" onClick={() => setHistory([])}>{t('aws.clearHistory')}</button>
            </div>
          )}
        </>
      )}

      {/* Quick service panels */}
      <h4 style={H_STYLE}>{t('aws.quickPanels')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('aws.quickHint')}
      </p>
      {panels.map((panel) => (
        <div key={panel.title} className="mod-toolbar">
          <span className="count-note" style={{ fontWeight: 600, minWidth: 150 }}>{panel.title}</span>
          {panel.actions.map((a) => (
            <button
              key={a.label}
              className="mini"
              disabled={busy}
              onClick={() => runPanel(a)}
              style={a.destructive ? { color: '#c0392b' } : undefined}
            >
              {a.label}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}
