// AWS CLI · full front-end over the official aws CLI — web parity port of
// WinForge/Pages/AwsCliModule.xaml(.cs) + Services/AwsCliService.cs.
// Feature surface: CLI detection (aws --version), profile/credential detection from
// ~/.aws (never reads secrets), profile/region/output context applied per command,
// Who-am-I, SSO login (opens a terminal), gated add/edit profile via `aws configure set`,
// dynamic service & operation browser (live `aws help` parse with built-in catalog
// fallback), --generate-cli-skeleton parameter forms + raw JSON (--cli-input-json),
// raw command box with stop/copy/save/clear/favorite, persisted history & favorites
// (localStorage, cap 200), JSON pretty output + AKIA/ASIA redaction, and quick panels
// for S3 / EC2 / IAM / Lambda / CloudWatch Logs / DynamoDB / ECS. Reads auto-run;
// every mutation runs only on an explicit click and destructive ones confirm first.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { getEnv, runCommand, runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, StatusDot, useAsync } from './common';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs } from './ModuleTabs';

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

// Fallback service catalog when live `aws help` enumeration is unavailable — port of
// WinForge/Catalog/AwsOperations.cs (the live list always wins when the CLI answers).
const COMMON_SERVICES = [
  'accessanalyzer', 'account', 'acm', 'acm-pca', 'amplify', 'apigateway', 'apigatewayv2',
  'appconfig', 'appflow', 'application-autoscaling', 'appstream', 'appsync', 'athena',
  'autoscaling', 'backup', 'batch', 'bedrock', 'bedrock-runtime', 'budgets', 'cloud9',
  'cloudformation', 'cloudfront', 'cloudhsm', 'cloudsearch', 'cloudtrail', 'cloudwatch',
  'codeartifact', 'codebuild', 'codecommit', 'codedeploy', 'codepipeline', 'codestar',
  'cognito-identity', 'cognito-idp', 'comprehend', 'config', 'connect', 'databrew',
  'datapipeline', 'datasync', 'dax', 'detective', 'devicefarm', 'directconnect', 'dlm',
  'dms', 'docdb', 'ds', 'dynamodb', 'dynamodbstreams', 'ebs', 'ec2', 'ecr', 'ecr-public',
  'ecs', 'efs', 'eks', 'elasticache', 'elasticbeanstalk', 'elastictranscoder', 'elb',
  'elbv2', 'emr', 'es', 'events', 'firehose', 'fms', 'forecast', 'fsx', 'gamelift',
  'glacier', 'globalaccelerator', 'glue', 'greengrass', 'guardduty', 'health', 'iam',
  'imagebuilder', 'inspector', 'inspector2', 'iot', 'iotanalytics', 'kafka', 'kendra',
  'kinesis', 'kinesisanalytics', 'kinesisvideo', 'kms', 'lakeformation', 'lambda', 'lex-models',
  'license-manager', 'lightsail', 'logs', 'macie2', 'mediaconnect', 'mediaconvert', 'medialive',
  'mediapackage', 'mediastore', 'mediatailor', 'memorydb', 'mgn', 'mq', 'neptune',
  'networkmanager', 'opensearch', 'opsworks', 'organizations', 'outposts', 'personalize',
  'pinpoint', 'polly', 'pricing', 'qldb', 'quicksight', 'ram', 'rds', 'rds-data',
  'redshift', 'rekognition', 'resource-groups', 'resourcegroupstaggingapi', 'robomaker',
  'route53', 'route53domains', 'route53resolver', 's3', 's3api', 's3control', 'sagemaker',
  'secretsmanager', 'securityhub', 'serverlessrepo', 'service-quotas', 'servicecatalog',
  'servicediscovery', 'ses', 'sesv2', 'shield', 'signer', 'sms', 'snowball', 'sns', 'sqs',
  'ssm', 'sso', 'sso-admin', 'stepfunctions', 'storagegateway', 'sts', 'support', 'swf',
  'synthetics', 'textract', 'timestream-query', 'timestream-write', 'transcribe', 'transfer',
  'translate', 'waf', 'wafv2', 'wellarchitected', 'workdocs', 'workmail', 'workspaces', 'xray',
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

const HIST_KEY = 'aws.history';
const FAV_KEY = 'aws.favorites';

const H_STYLE: CSSProperties = { fontSize: 14, fontWeight: 600, margin: '14px 0 2px' };
const LIST_BOX: CSSProperties = {
  maxHeight: 220,
  overflowY: 'auto',
  border: '1px solid var(--stroke)',
  borderRadius: 6,
  padding: 6,
  marginTop: 6,
};
const ITEM_STYLE: CSSProperties = { display: 'block', width: '100%', textAlign: 'left', marginBottom: 2 };
const FIELD_STYLE: CSSProperties = { display: 'block', width: '100%', maxWidth: 440, marginBottom: 6 };

interface ParamField {
  flag: string;
  placeholder: string;
  value: string;
}

interface PendingField {
  key: string;
  label: string;
  multiline?: boolean;
}

interface PendingForm {
  title: string;
  note?: string;
  destructive?: boolean;
  submitLabel: string;
  fields: PendingField[];
  /** Builds the aws args from the field values; return null to keep the form open. */
  build?: (v: Record<string, string>) => string | null;
  special?: 'lambda';
}

interface QuickAction {
  label: string;
  /** Direct (read-only) run — never used for mutations. */
  args?: string;
  destructive?: boolean;
  form?: { title: string; fields: PendingField[]; build?: (v: Record<string, string>) => string | null; special?: 'lambda' };
}

// ── small pure helpers (ports of AwsCliService statics) ────────────────────────────

const lsGet = (key: string, fallback: string): string => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

const loadList = (key: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const saveList = (key: string, list: string[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
};

/** Best-effort redaction of anything access-key-shaped (AKIA/ASIA…). */
const redact = (text: string): string => text.replace(/\b(AKIA|ASIA)[0-9A-Z]{2,}/g, 'AKIA****************');

/** Pretty-print when the text is JSON; otherwise return unchanged. */
const pretty = (s: string): string => {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return s;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return s;
  }
};

/** Keep the output buffer bounded like the C# page (200k → keep last 150k). */
const bound = (s: string): string => (s.length > 200_000 ? s.slice(-150_000) : s);

const isEmptyJson = (json: string): boolean => {
  const t = json.trim();
  return t.length === 0 || t === '{}' || t === '[]';
};

const camelToKebab = (name: string): string =>
  name.replace(/[A-Z]/g, (m, off: number) => (off > 0 ? '-' : '') + m.toLowerCase());

const psEsc = (s: string): string => s.replace(/'/g, "''");

/** aws help output may be backspace-bolded (x\bx) — strip those sequences. */
const stripBackspaceBold = (s: string): string => {
  if (!s.includes('\b')) return s;
  let out = '';
  for (const c of s) {
    if (c === '\b') out = out.slice(0, -1);
    else out += c;
  }
  return out;
};

/** Parse an indented item list from `aws help` text (AVAILABLE SERVICES / AVAILABLE COMMANDS). */
const parseHelpItems = (help: string, startMarker: string, endMarker: string): string[] => {
  const items: string[] = [];
  if (!help) return items;
  const lines = stripBackspaceBold(help).replace(/\r/g, '').split('\n');
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed.toUpperCase() === startMarker) inSection = true;
      continue;
    }
    if (trimmed.toUpperCase() === endMarker) break;
    // section headers are all-caps with no leading whitespace; stop on a new header
    const first = line.charAt(0);
    if (trimmed.length > 0 && first !== '' && !/\s/.test(first) && trimmed === trimmed.toUpperCase() && /^[A-Z ]+$/.test(trimmed)) break;
    // items look like "o  servicename" or "       servicename"
    let token = trimmed.replace(/^[o*+-]\s+/, '').trim();
    if (!token) continue;
    token = (token.split(/\s/)[0] ?? '').trim();
    if (token && /^[A-Za-z0-9_-]+$/.test(token) && !items.includes(token)) items.push(token);
  }
  return items;
};

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

  // ── context (profile / region / output) — persisted like AwsCliService.PersistContext ──
  const [profile, setProfile] = useState(() => lsGet('aws.profile', ''));
  const [region, setRegion] = useState(() => {
    const r = lsGet('aws.region', '');
    return ALL_REGIONS.includes(r) ? r : '';
  });
  const [output, setOutput] = useState(() => {
    const o = lsGet('aws.output', 'json');
    return OUTPUT_FORMATS.includes(o) ? o : 'json';
  });
  useEffect(() => {
    try {
      localStorage.setItem('aws.profile', profile);
      localStorage.setItem('aws.region', region);
      localStorage.setItem('aws.output', output);
    } catch {
      /* storage unavailable */
    }
  }, [profile, region, output]);

  // ── shared output pane / run state ──
  const [raw, setRaw] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const busyRef = useRef(false);
  const runIdRef = useRef(0);

  // ── history & favorites — persisted (cap 200 like the C# service) ──
  const [history, setHistory] = useState<string[]>(() => loadList(HIST_KEY));
  const [favorites, setFavorites] = useState<string[]>(() => loadList(FAV_KEY));

  // ── command browser state ──
  const [svcFilter, setSvcFilter] = useState('');
  const [opFilter, setOpFilter] = useState('');
  const [selSvc, setSelSvc] = useState<string | null>(null);
  const [selOp, setSelOp] = useState<string | null>(null);
  const [ops, setOps] = useState<string[]>([]);
  const [opsLoading, setOpsLoading] = useState(false);
  const [skelLoading, setSkelLoading] = useState(false);
  const [fields, setFields] = useState<ParamField[]>([]);
  const [complexNames, setComplexNames] = useState<string[]>([]);
  const [skelNote, setSkelNote] = useState<string | null>(null);
  const [rawJson, setRawJson] = useState('');
  const [showJson, setShowJson] = useState(false);
  const svcReqRef = useRef(0);

  // ── add/edit profile (gated save) ──
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgName, setCfgName] = useState('');
  const [cfgKey, setCfgKey] = useState('');
  const [cfgSecret, setCfgSecret] = useState('');
  const [cfgRegion, setCfgRegion] = useState('');
  const [cfgOutput, setCfgOutput] = useState('');
  const [cfgBusy, setCfgBusy] = useState(false);

  // ── quick-panel pending form (web equivalent of the C# ContentDialog prompts) ──
  const [pending, setPending] = useState<PendingForm | null>(null);
  const [pendingVals, setPendingVals] = useState<Record<string, string>>({});

  const version = useAsync(async () => {
    const res = await runCommand(awsPath, ['--version']);
    return (res.stdout || res.stderr || '').trim();
  }, [awsPath]);

  const profiles = useAsync(() => runPowershellJson<AwsProfile>(PROFILES_PS), []);

  // Live service enumeration via `aws help`; falls back to the built-in catalog.
  const services = useAsync<{ list: string[]; live: boolean }>(async () => {
    try {
      const res = await runCommand(awsPath, ['help']);
      const list = parseHelpItems(res.stdout || res.stderr, 'AVAILABLE SERVICES', 'SEE ALSO');
      if (list.length > 0) return { list, live: true };
    } catch {
      /* fall through to catalog */
    }
    return { list: [...COMMON_SERVICES], live: false };
  }, [awsPath]);

  // Split a raw "s3 ls s3://x" string into argv, honouring double quotes.
  const toArgs = (s: string): string[] => {
    const parts = s.match(/"[^"]*"|\S+/g) ?? [];
    return parts.map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p));
  };

  // Append active profile/region/output unless the command already sets them (C# Decorate).
  const decorate = (argv: string[]): string[] => {
    const flags = argv.join(' ').toLowerCase();
    const extra: string[] = [];
    if (profile && !flags.includes('--profile')) extra.push('--profile', profile);
    if (region && !flags.includes('--region')) extra.push('--region', region);
    if (output && !flags.includes('--output')) extra.push('--output', output);
    return [...argv, ...extra];
  };

  const pushHistory = (cmd: string) => {
    const c = cmd.trim();
    if (!c) return;
    setHistory((h) => {
      const next = [c, ...h.filter((x) => x.toLowerCase() !== c.toLowerCase())].slice(0, 200);
      saveList(HIST_KEY, next);
      return next;
    });
  };

  const clearHistory = () => {
    setHistory([]);
    saveList(HIST_KEY, []);
  };

  const toggleFavoriteCmd = (cmd: string) => {
    let c = cmd.trim();
    if (c.toLowerCase().startsWith('aws ')) c = c.slice(4).trim();
    if (!c) return;
    const has = favorites.some((x) => x.toLowerCase() === c.toLowerCase());
    const next = has ? favorites.filter((x) => x.toLowerCase() !== c.toLowerCase()) : [c, ...favorites];
    setFavorites(next);
    saveList(FAV_KEY, next);
    setMsg(has ? t('aws.favRemoved') : t('aws.favAdded'));
  };

  /**
   * Core runner: argv is passed straight to the aws executable (no shell), so values
   * with spaces / JSON blobs are single tokens and never need quoting. Returns true
   * when the command completed and was not stopped.
   */
  const runArgv = async (argv: string[], opts: { record?: string; decorate?: boolean } = {}): Promise<boolean> => {
    if (busyRef.current) {
      setMsg(t('aws.runningAlready'));
      return false;
    }
    const id = ++runIdRef.current;
    const final = opts.decorate === false ? argv : decorate(argv);
    const display = final
      .map((a) => (a.length > 160 ? `${a.slice(0, 157)}…` : /\s/.test(a) ? `"${a}"` : a))
      .join(' ');
    busyRef.current = true;
    setBusy(true);
    setMsg(null);
    setOut(`$ aws ${display}\n`);
    if (opts.record) pushHistory(opts.record);
    try {
      const res = await runCommand(awsPath, final);
      if (runIdRef.current !== id) return false; // stopped — discard the late result
      const body =
        [res.stdout.trim() ? pretty(res.stdout.trim()) : '', res.stderr.trim()].filter(Boolean).join('\n') ||
        t('aws.noOutput');
      setOut(bound(`$ aws ${display}\n\n${redact(body)}\n\n${t('aws.exit', { code: res.code })}`));
      return true;
    } catch (e) {
      if (runIdRef.current !== id) return false;
      setOut(`$ aws ${display}\n\n${String(e)}`);
      return false;
    } finally {
      if (runIdRef.current === id) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const runAws = async (argsStr: string, record = true) => {
    let s = argsStr.trim();
    if (s.toLowerCase().startsWith('aws ')) s = s.slice(4).trim();
    if (!s) return;
    await runArgv(toArgs(s), { record: record ? s : undefined });
  };

  /** Web equivalent of C# StopStream: discard the in-flight result and unlock the UI. */
  const stop = () => {
    if (!busyRef.current) return;
    runIdRef.current++;
    busyRef.current = false;
    setBusy(false);
    setOut((o) => `${o}\n${t('aws.stopped')}`);
  };

  const copyOut = async () => {
    try {
      await navigator.clipboard.writeText(out);
      setMsg(t('aws.copied'));
    } catch {
      /* clipboard unavailable in this context */
    }
  };

  /** C# RawSave_Click → browser download of the output pane. */
  const saveOut = () => {
    try {
      const blob = new Blob([out], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'aws-output.txt';
      a.click();
      URL.revokeObjectURL(url);
      setMsg(t('aws.outSaved', { name: 'aws-output.txt' }));
    } catch (e) {
      setMsg(String(e));
    }
  };

  /** SSO login is interactive (opens a browser + waits) — launch aws in its own console window. */
  const ssoLogin = async () => {
    try {
      const args = ["'sso'", "'login'"];
      if (profile) args.push("'--profile'", `'${psEsc(profile)}'`);
      const r = await runPowershell(`Start-Process -FilePath '${psEsc(awsPath)}' -ArgumentList ${args.join(',')}`);
      if (!r.success) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      setMsg(t('aws.ssoLaunched'));
    } catch (e) {
      setMsg(t('aws.ssoFailed', { error: String(e) }));
    }
  };

  /** `aws configure list` — effective credential chain for the active profile (read-only). */
  const checkCreds = () => {
    void runArgv(['configure', 'list', ...(profile ? ['--profile', profile] : [])], { decorate: false });
  };

  /**
   * Gated profile save via `aws configure set` — the secret travels only as a process
   * argument to the local aws CLI, is never echoed into the output pane, and files
   * under ~/.aws are only ever written by aws itself after an explicit Save click.
   */
  const saveProfile = async () => {
    const name = cfgName.trim();
    if (!name) {
      setMsg(t('aws.profileNameRequired'));
      return;
    }
    setCfgBusy(true);
    try {
      const step = async (args: string[]) => {
        const r = await runCommand(awsPath, args);
        if (!r.success) throw new Error(redact(r.stderr.trim() || `exit ${r.code}`));
      };
      if (cfgKey.trim()) await step(['configure', 'set', 'aws_access_key_id', cfgKey.trim(), '--profile', name]);
      if (cfgSecret) await step(['configure', 'set', 'aws_secret_access_key', cfgSecret, '--profile', name]);
      if (cfgRegion.trim()) await step(['configure', 'set', 'region', cfgRegion.trim(), '--profile', name]);
      if (cfgOutput.trim()) await step(['configure', 'set', 'output', cfgOutput.trim(), '--profile', name]);
      setMsg(t('aws.profileSaved', { name }));
      setProfile(name);
      if (cfgRegion.trim() && ALL_REGIONS.includes(cfgRegion.trim())) setRegion(cfgRegion.trim());
      setCfgOpen(false);
      setCfgKey('');
      setCfgSecret('');
      profiles.reload();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setCfgBusy(false);
    }
  };

  const openCfg = () => {
    setCfgName(profile);
    setCfgKey('');
    setCfgSecret('');
    setCfgRegion(region);
    setCfgOutput(output);
    setCfgOpen(true);
  };

  // ── command browser handlers ──
  const selectService = async (s: string) => {
    const req = ++svcReqRef.current;
    setSelSvc(s);
    setSelOp(null);
    setOps([]);
    setOpFilter('');
    setFields([]);
    setComplexNames([]);
    setSkelNote(null);
    setRawJson('');
    setOpsLoading(true);
    try {
      const res = await runCommand(awsPath, [s, 'help']);
      if (svcReqRef.current !== req) return;
      setOps(parseHelpItems(res.stdout || res.stderr, 'AVAILABLE COMMANDS', 'SEE ALSO'));
    } catch {
      if (svcReqRef.current === req) setOps([]);
    } finally {
      if (svcReqRef.current === req) setOpsLoading(false);
    }
  };

  const selectOperation = async (op: string) => {
    const req = ++svcReqRef.current;
    setSelOp(op);
    setFields([]);
    setComplexNames([]);
    setSkelNote(null);
    setRawJson('');
    if (!selSvc) return;
    setSkelLoading(true);
    try {
      const res = await runCommand(awsPath, [selSvc, op, '--generate-cli-skeleton', 'input']);
      if (svcReqRef.current !== req) return;
      const rawTxt = (res.stdout || '').trim();
      const a = rawTxt.indexOf('{');
      const b = rawTxt.lastIndexOf('}');
      const skel = a >= 0 && b > a ? rawTxt.slice(a, b + 1) : rawTxt;
      if (!skel) {
        setRawJson('{}');
        setSkelNote(t('aws.noParams'));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(skel);
        setRawJson(JSON.stringify(parsed, null, 2));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const flds: ParamField[] = [];
          const cx: string[] = [];
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            // Only simple (string/number/bool) top-level params become fields; complex
            // (object/array) params are best edited via the raw JSON box — like the C# page.
            if (v !== null && typeof v === 'object') cx.push(k);
            else flds.push({ flag: `--${camelToKebab(k)}`, placeholder: v === null ? '' : String(v), value: '' });
          }
          setFields(flds);
          setComplexNames(cx);
          if (flds.length === 0 && cx.length === 0) setSkelNote(t('aws.noParams'));
        } else {
          setSkelNote(t('aws.noParams'));
        }
      } catch {
        setRawJson(skel);
        setSkelNote(t('aws.skeletonFail'));
      }
    } catch (e) {
      if (svcReqRef.current === req) setSkelNote(String(e));
    } finally {
      if (svcReqRef.current === req) setSkelLoading(false);
    }
  };

  const setFieldValue = (i: number, value: string) =>
    setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, value } : f)));

  const buildRun = async () => {
    if (!selSvc || !selOp) {
      setMsg(t('aws.pickFirst'));
      return;
    }
    if (showJson && !isEmptyJson(rawJson)) {
      // Raw JSON overrides the fields → --cli-input-json as a single argv token (no temp file needed).
      await runArgv([selSvc, selOp, '--cli-input-json', rawJson]);
      return;
    }
    const argv = [selSvc, selOp];
    const rec = [selSvc, selOp];
    for (const f of fields) {
      const v = f.value.trim();
      if (!v) continue;
      argv.push(f.flag, v);
      rec.push(f.flag, /\s/.test(v) ? `"${v}"` : v);
    }
    await runArgv(argv, { record: rec.join(' ') });
  };

  const showHelp = async () => {
    if (!selSvc) return;
    await runArgv(selOp ? [selSvc, selOp, 'help'] : [selSvc, 'help'], { decorate: false });
  };

  // ── quick panels (S3 / EC2 / IAM / Lambda / Logs / DynamoDB / ECS) ──
  const openForm = (a: QuickAction) => {
    if (!a.form) return;
    setPendingVals({});
    setPending({
      title: a.form.title,
      note: a.destructive ? t('aws.destructiveNote') : undefined,
      destructive: a.destructive,
      submitLabel: a.destructive ? t('aws.confirmRun') : a.form.special === 'lambda' ? t('aws.invoke') : t('aws.run'),
      fields: a.form.fields,
      build: a.form.build,
      special: a.form.special,
    });
  };

  const onQuick = (a: QuickAction) => {
    if (a.form) openForm(a);
    else if (a.args) void runAws(a.args);
  };

  /** Lambda invoke: response goes to a temp outfile which we then read back and show. */
  const invokeLambda = async (vals: Record<string, string>) => {
    const name = (vals.fn ?? '').trim();
    if (!name) return;
    const payload = (vals.payload ?? '').trim();
    let temp = '';
    try {
      temp = (await getEnv('TEMP')).trim();
    } catch {
      temp = '';
    }
    const outFile = `${temp || '.'}\\winforge-lambda-out-${Date.now()}.json`;
    const argv = ['lambda', 'invoke', '--function-name', name];
    if (payload) argv.push('--payload', payload, '--cli-binary-format', 'raw-in-base64-out');
    argv.push(outFile);
    const ok = await runArgv(argv);
    if (!ok) return;
    try {
      const r = await runPowershell(
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; if (Test-Path -LiteralPath '${psEsc(outFile)}') { Get-Content -LiteralPath '${psEsc(outFile)}' -Raw; Remove-Item -LiteralPath '${psEsc(outFile)}' -Force -ErrorAction SilentlyContinue }`,
      );
      const body = (r.stdout || '').trim();
      if (body) setOut((o) => bound(`${o}\n\n${t('aws.respHeader')}\n${redact(pretty(body))}`));
    } catch {
      /* response file unavailable */
    }
  };

  const submitPending = async () => {
    if (!pending) return;
    if (pending.special === 'lambda') {
      if (!(pendingVals.fn ?? '').trim()) return;
      const vals = pendingVals;
      setPending(null);
      setPendingVals({});
      await invokeLambda(vals);
      return;
    }
    const args = pending.build ? pending.build(pendingVals) : null;
    if (!args) return;
    setPending(null);
    setPendingVals({});
    await runAws(args);
  };

  const profileRows = useMemo(() => profiles.data ?? [], [profiles.data]);

  const shownServices = useMemo(() => {
    const all = services.data?.list ?? [];
    const q = svcFilter.trim().toLowerCase();
    return q ? all.filter((s) => s.toLowerCase().includes(q)) : all;
  }, [services.data, svcFilter]);

  const shownOps = useMemo(() => {
    const q = opFilter.trim().toLowerCase();
    return q ? ops.filter((o) => o.toLowerCase().includes(q)) : ops;
  }, [ops, opFilter]);

  const onProfileSelect = (name: string) => {
    setProfile(name);
    // If the profile carries its own region, reflect it (C# ProfileBox_Changed).
    const p = profileRows.find((x) => x.Name === name);
    if (p && p.Region && ALL_REGIONS.includes(p.Region)) setRegion(p.Region);
  };

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
        <button className="mini" onClick={() => onProfileSelect(p.Name)}>
          {t('aws.use')}
        </button>
      ),
    },
  ];

  const panels: { title: string; actions: QuickAction[] }[] = [
    {
      title: t('aws.panelS3'),
      actions: [
        { label: t('aws.s3ListBuckets'), args: 's3 ls' },
        {
          label: t('aws.s3ListObjects'),
          form: {
            title: t('aws.s3ListObjects'),
            fields: [{ key: 'v', label: t('aws.promptBucketPrefix') }],
            build: (v) => {
              const b = (v.v ?? '').trim();
              return b ? `s3 ls s3://${b} --recursive` : null;
            },
          },
        },
        {
          label: t('aws.s3Upload'),
          form: {
            title: t('aws.uploadTitle'),
            fields: [
              { key: 'local', label: t('aws.localFile') },
              { key: 'dest', label: t('aws.s3Dest') },
            ],
            build: (v) => {
              const l = (v.local ?? '').trim();
              const d = (v.dest ?? '').trim();
              return l && d ? `s3 cp "${l}" s3://${d}` : null;
            },
          },
        },
        {
          label: t('aws.s3Download'),
          form: {
            title: t('aws.downloadTitle'),
            fields: [
              { key: 'src', label: t('aws.s3Src') },
              { key: 'dest', label: t('aws.localDest') },
            ],
            build: (v) => {
              const s = (v.src ?? '').trim();
              const d = (v.dest ?? '').trim();
              return s && d ? `s3 cp s3://${s} "${d}"` : null;
            },
          },
        },
        {
          label: t('aws.s3MakeBucket'),
          form: {
            title: t('aws.s3MakeBucket'),
            fields: [{ key: 'v', label: t('aws.promptNewBucket') }],
            build: (v) => {
              const b = (v.v ?? '').trim();
              return b ? `s3 mb s3://${b}` : null;
            },
          },
        },
        {
          label: t('aws.s3RemoveBucket'),
          destructive: true,
          form: {
            title: t('aws.s3RemoveBucket'),
            fields: [{ key: 'v', label: t('aws.promptBucketEmpty') }],
            build: (v) => {
              const b = (v.v ?? '').trim();
              return b ? `s3 rb s3://${b}` : null;
            },
          },
        },
      ],
    },
    {
      title: t('aws.panelEc2'),
      actions: [
        { label: t('aws.ec2Describe'), args: 'ec2 describe-instances --output table' },
        {
          label: t('aws.ec2Start'),
          form: {
            title: t('aws.ec2Start'),
            fields: [{ key: 'v', label: t('aws.promptInstanceId') }],
            build: (v) => {
              const id = (v.v ?? '').trim();
              return id ? `ec2 start-instances --instance-ids ${id}` : null;
            },
          },
        },
        {
          label: t('aws.ec2Stop'),
          form: {
            title: t('aws.ec2Stop'),
            fields: [{ key: 'v', label: t('aws.promptInstanceId') }],
            build: (v) => {
              const id = (v.v ?? '').trim();
              return id ? `ec2 stop-instances --instance-ids ${id}` : null;
            },
          },
        },
        {
          label: t('aws.ec2Reboot'),
          form: {
            title: t('aws.ec2Reboot'),
            fields: [{ key: 'v', label: t('aws.promptInstanceId') }],
            build: (v) => {
              const id = (v.v ?? '').trim();
              return id ? `ec2 reboot-instances --instance-ids ${id}` : null;
            },
          },
        },
        {
          label: t('aws.ec2Terminate'),
          destructive: true,
          form: {
            title: t('aws.ec2Terminate'),
            fields: [{ key: 'v', label: t('aws.promptInstanceId') }],
            build: (v) => {
              const id = (v.v ?? '').trim();
              return id ? `ec2 terminate-instances --instance-ids ${id}` : null;
            },
          },
        },
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
        {
          label: t('aws.lambdaInvoke'),
          form: {
            title: t('aws.invokeTitle'),
            fields: [
              { key: 'fn', label: t('aws.fnName') },
              { key: 'payload', label: t('aws.payloadJson'), multiline: true },
            ],
            special: 'lambda',
          },
        },
      ],
    },
    {
      title: t('aws.panelLogs'),
      actions: [
        { label: t('aws.logsGroups'), args: 'logs describe-log-groups --output table' },
        {
          label: t('aws.logsTail'),
          form: {
            title: t('aws.tailTitle'),
            fields: [
              { key: 'group', label: t('aws.logGroupName') },
              { key: 'since', label: t('aws.sinceLabel') },
            ],
            build: (v) => {
              const g = (v.group ?? '').trim();
              const since = (v.since ?? '').trim() || '15m';
              return g ? `logs tail ${g} --since ${since} --format short` : null;
            },
          },
        },
      ],
    },
    {
      title: t('aws.panelDynamo'),
      actions: [
        { label: t('aws.ddbTables'), args: 'dynamodb list-tables' },
        {
          label: t('aws.ddbDescribe'),
          form: {
            title: t('aws.ddbDescribe'),
            fields: [{ key: 'v', label: t('aws.tableName') }],
            build: (v) => {
              const n = (v.v ?? '').trim();
              return n ? `dynamodb describe-table --table-name ${n}` : null;
            },
          },
        },
      ],
    },
    {
      title: t('aws.panelEcs'),
      actions: [
        { label: t('aws.ecsClusters'), args: 'ecs list-clusters' },
        {
          label: t('aws.ecsServices'),
          form: {
            title: t('aws.ecsServices'),
            fields: [{ key: 'v', label: t('aws.clusterName') }],
            build: (v) => {
              const c = (v.v ?? '').trim();
              return c ? `ecs list-services --cluster ${c}` : null;
            },
          },
        },
      ],
    },
  ];

  const renderCmdList = (list: string[], kind: 'hist' | 'fav') => (
    <div style={{ maxHeight: 200, overflowY: 'auto' }}>
      {list.length === 0 && (
        <p className="count-note">{kind === 'hist' ? t('aws.noHistory') : t('aws.noFavorites')}</p>
      )}
      {list.map((c, i) => (
        <div key={`${c}-${i}`} className="mod-toolbar" style={{ marginBottom: 2, flexWrap: 'nowrap' }}>
          <code
            className="count-note"
            style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={`aws ${c}`}
          >
            aws {c}
          </code>
          <button className="mini" disabled={busy} onClick={() => { setRaw(c); void runAws(c); }}>
            {t('aws.run')}
          </button>
          {kind === 'hist' ? (
            <button className="mini" title={t('aws.favorite')} onClick={() => toggleFavoriteCmd(c)}>★</button>
          ) : (
            <button className="mini" onClick={() => toggleFavoriteCmd(c)}>{t('aws.favRemove')}</button>
          )}
        </div>
      ))}
    </div>
  );

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
      {msg && <p className="mod-msg">{msg}</p>}

      {/* ===== A) Profile & context ===== */}
      <h4 style={H_STYLE}>{t('aws.context')}</h4>
      <ModuleToolbar>
        <label className="count-note">{t('aws.profile')}</label>
        <select className="mod-search" value={profile} onChange={(e) => onProfileSelect(e.target.value)}>
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
        <button className="mini" disabled={busy} onClick={checkCreds}>
          {t('aws.checkCreds')}
        </button>
        <button className="mini" onClick={() => void ssoLogin()}>
          {t('aws.ssoLogin')}
        </button>
        <button className="mini" onClick={openCfg}>
          {t('aws.configureProfile')}
        </button>
        <button className="mini" onClick={profiles.reload}>
          ⟳ {t('modules.refresh')}
        </button>
      </ModuleToolbar>

      {cfgOpen && (
        <div className="dep-gate" style={{ margin: '8px 0' }}>
          <p style={{ fontWeight: 600, marginTop: 0 }}>{t('aws.configureProfile')}</p>
          <p className="count-note" style={{ marginTop: 0 }}>{t('aws.configureNote')}</p>
          <input className="mod-search" style={FIELD_STYLE} placeholder={t('aws.cfgProfileName')} value={cfgName} onChange={(e) => setCfgName(e.target.value)} />
          <input className="mod-search" style={FIELD_STYLE} placeholder={t('aws.cfgKeyId')} value={cfgKey} onChange={(e) => setCfgKey(e.target.value)} autoComplete="off" />
          <input className="mod-search" style={FIELD_STYLE} type="password" placeholder={t('aws.cfgSecret')} value={cfgSecret} onChange={(e) => setCfgSecret(e.target.value)} autoComplete="new-password" />
          <input className="mod-search" style={FIELD_STYLE} placeholder={t('aws.cfgRegion')} value={cfgRegion} onChange={(e) => setCfgRegion(e.target.value)} />
          <input className="mod-search" style={FIELD_STYLE} placeholder={t('aws.cfgOutput')} value={cfgOutput} onChange={(e) => setCfgOutput(e.target.value)} />
          <div className="mod-toolbar">
            <button className="mini primary" disabled={cfgBusy} onClick={() => void saveProfile()}>
              {cfgBusy ? t('aws.running') : t('aws.save')}
            </button>
            <button className="mini" disabled={cfgBusy} onClick={() => setCfgOpen(false)}>
              {t('aws.cancel')}
            </button>
          </div>
        </div>
      )}

      <AsyncState loading={profiles.loading} error={profiles.error}>
        <DataTable columns={profileColumns} rows={profileRows} rowKey={(p) => p.Name} empty={t('aws.noProfiles')} />
      </AsyncState>

      {/* ===== B) Command browser (every service & operation) ===== */}
      <h4 style={H_STYLE}>{t('aws.browser')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('aws.browserHint')}
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 240 }}>
          <label className="count-note">
            {t('aws.services')}
            {services.data && (
              <> · {shownServices.length} · {services.data.live ? t('aws.srcLive') : t('aws.srcCatalog')}</>
            )}
          </label>
          <input
            className="mod-search"
            style={{ width: '100%', marginTop: 4 }}
            placeholder={t('aws.filterServices')}
            value={svcFilter}
            onChange={(e) => setSvcFilter(e.target.value)}
          />
          <div style={LIST_BOX}>
            {services.loading && <p className="count-note">{t('modules.loading')}</p>}
            {shownServices.map((s) => (
              <button
                key={s}
                className="mini"
                style={{ ...ITEM_STYLE, ...(s === selSvc ? { outline: '1px solid var(--accent)' } : {}) }}
                onClick={() => void selectService(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div style={{ flex: '1 1 260px', minWidth: 240 }}>
          <label className="count-note">
            {t('aws.operations')}
            {selSvc ? ` · ${selSvc} · ${shownOps.length}` : ''}
          </label>
          <input
            className="mod-search"
            style={{ width: '100%', marginTop: 4 }}
            placeholder={t('aws.filterOperations')}
            value={opFilter}
            onChange={(e) => setOpFilter(e.target.value)}
          />
          <div style={LIST_BOX}>
            {!selSvc && <p className="count-note">{t('aws.pickService')}</p>}
            {opsLoading && <p className="count-note">{t('modules.loading')}</p>}
            {shownOps.map((o) => (
              <button
                key={o}
                className="mini"
                style={{ ...ITEM_STYLE, ...(o === selOp ? { outline: '1px solid var(--accent)' } : {}) }}
                onClick={() => void selectOperation(o)}
              >
                {o}
              </button>
            ))}
          </div>
        </div>
      </div>

      {selSvc && (
        <>
          {selOp && (
            <>
              <p style={{ fontWeight: 600, margin: '10px 0 4px' }}>
                {t('aws.params')} — <code>{selSvc} {selOp}</code>
              </p>
              {skelLoading ? (
                <p className="count-note">{t('modules.loading')}</p>
              ) : (
                <>
                  {skelNote && <p className="count-note" style={{ margin: '2px 0' }}>{skelNote}</p>}
                  {complexNames.map((n) => (
                    <p key={n} className="count-note" style={{ margin: '2px 0' }}>
                      {t('aws.complexParam', { name: n })}
                    </p>
                  ))}
                  {fields.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {fields.map((f, i) => (
                        <label key={f.flag} className="count-note" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <code>{f.flag}</code>
                          <input
                            className="mod-search"
                            placeholder={f.placeholder}
                            value={f.value}
                            onChange={(e) => setFieldValue(i, e.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <div className="mod-toolbar" style={{ marginTop: 8 }}>
            <button className="mini" onClick={() => setShowJson((v) => !v)}>
              {t('aws.rawJson')}
            </button>
            <button className="mini primary" disabled={busy || !selOp} onClick={() => void buildRun()}>
              {t('aws.buildRun')}
            </button>
            <button className="mini" disabled={busy} onClick={() => void showHelp()}>
              {t('aws.help')}
            </button>
          </div>
          {showJson && (
            <>
              <p className="count-note" style={{ margin: '6px 0 2px' }}>{t('aws.rawJsonNote')}</p>
              <textarea
                className="hosts-edit"
                style={{ minHeight: 140 }}
                value={rawJson}
                onChange={(e) => setRawJson(e.target.value)}
                spellCheck={false}
              />
            </>
          )}
        </>
      )}

      {/* ===== B2) Raw command box ===== */}
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
        <button className="mini" disabled={!busy} onClick={stop}>
          {t('aws.stop')}
        </button>
        <button className="mini" onClick={() => toggleFavoriteCmd(raw)}>★ {t('aws.favorite')}</button>
        <button className="mini" disabled={!out} onClick={copyOut}>{t('aws.copy')}</button>
        <button className="mini" disabled={!out} onClick={saveOut}>{t('aws.saveOutput')}</button>
        <button className="mini" disabled={!out} onClick={() => setOut('')}>{t('aws.clear')}</button>
      </div>
      {out && <pre className="cmd-out">{out}</pre>}

      {/* ===== History & favorites (persisted) ===== */}
      <h4 style={H_STYLE}>{t('aws.historyFav')}</h4>
      <ModuleTabs
        tabs={[
          {
            id: 'history',
            en: 'History',
            zh: '歷史',
            render: () => (
              <>
                <div className="mod-toolbar">
                  <button className="mini" disabled={history.length === 0} onClick={clearHistory}>
                    {t('aws.clearHistory')}
                  </button>
                </div>
                {renderCmdList(history, 'hist')}
              </>
            ),
          },
          {
            id: 'favorites',
            en: 'Favorites',
            zh: '收藏',
            render: () => renderCmdList(favorites, 'fav'),
          },
        ]}
      />

      {/* ===== C) Quick service panels ===== */}
      <h4 style={H_STYLE}>{t('aws.quickPanels')}</h4>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('aws.quickHint')}
      </p>

      {pending && (
        <div className="dep-gate" style={{ marginBottom: 10 }}>
          <p style={{ fontWeight: 600, marginTop: 0 }}>{pending.title}</p>
          {pending.note && (
            <p className="count-note" style={{ color: '#c0392b', marginTop: 0 }}>{pending.note}</p>
          )}
          {pending.fields.map((f) =>
            f.multiline ? (
              <textarea
                key={f.key}
                className="hosts-edit"
                style={{ minHeight: 80, marginBottom: 6 }}
                placeholder={f.label}
                value={pendingVals[f.key] ?? ''}
                onChange={(e) => setPendingVals((v) => ({ ...v, [f.key]: e.target.value }))}
                spellCheck={false}
              />
            ) : (
              <input
                key={f.key}
                className="mod-search"
                style={FIELD_STYLE}
                placeholder={f.label}
                value={pendingVals[f.key] ?? ''}
                onChange={(e) => setPendingVals((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            ),
          )}
          <div className="mod-toolbar">
            <button
              className={`mini${pending.destructive ? '' : ' primary'}`}
              style={pending.destructive ? { color: '#c0392b' } : undefined}
              disabled={busy}
              onClick={() => void submitPending()}
            >
              {pending.submitLabel}
            </button>
            <button className="mini" onClick={() => { setPending(null); setPendingVals({}); }}>
              {t('aws.cancel')}
            </button>
          </div>
        </div>
      )}

      {panels.map((panel) => (
        <div key={panel.title} className="mod-toolbar">
          <span className="count-note" style={{ fontWeight: 600, minWidth: 150 }}>{panel.title}</span>
          {panel.actions.map((a) => (
            <button
              key={a.label}
              className="mini"
              disabled={busy}
              onClick={() => onQuick(a)}
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
