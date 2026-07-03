import { useTranslation } from 'react-i18next';
import { useAsync, AsyncState, ModuleToolbar, StatusDot, DataTable, type Column } from './common';
import { runPowershellJson, isTauri } from '../tauri/bridge';
import { allModules, catalog } from '../data/catalog';
import { registeredModuleTags } from './registryKeys';
import { pick } from '../i18n';
import { requestModuleOpen, requestPaletteOpen } from '../state/navBus';
import '../styles/favorites.css';

// Port of WinForge Pages/DashboardPage: hero + counts, system-at-a-glance,
// flagship reactor tile + quick module tiles, and a master search entry.
// Search/browse chrome already lives in the shell (palette, sidebar), so the
// search box here simply seeds the command palette.

interface Glance {
  os: string;
  cpu: string;
  threads: number;
  arch: string;
  ram: string;
  gpu: string;
  sysDrive: string;
  uptime: string;
  boot: string;
}

const GLANCE_PS = `
$os  = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpu = Get-CimInstance Win32_VideoController | Select-Object -First 1
$sd  = $env:SystemDrive
$vol = Get-PSDrive -Name $sd.TrimEnd(':')
$up  = (Get-Date) - $os.LastBootUpTime
$ramTotal = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$ramFree  = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
[pscustomobject]@{
  os       = "$($os.Caption) (build $($os.BuildNumber))"
  cpu      = $cpu.Name.Trim()
  threads  = [int]$cpu.NumberOfLogicalProcessors
  arch     = $env:PROCESSOR_ARCHITECTURE
  ram      = "$([math]::Round($ramTotal - $ramFree, 1)) / $ramTotal GB"
  gpu      = "$($gpu.Name)"
  sysDrive = "$sd $([math]::Round($vol.Free / 1GB)) GB free of $([math]::Round(($vol.Used + $vol.Free) / 1GB)) GB"
  uptime   = "$($up.Days)d $($up.Hours)h $($up.Minutes)m"
  boot     = $os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm')
} | ConvertTo-Json
`;

// Curated quick-access tiles, mirroring the WinForge dashboard's tile wall
// (subset — the full catalog is one click away). Tags missing from the
// catalog are skipped, so this list never breaks as the catalog evolves.
const QUICK_TAGS = [
  'module.git',
  'module.archives',
  'module.doctors',
  'module.services',
  'module.tasks',
  'module.devices',
  'module.startup',
  'module.monitor',
  'module.disk',
  'module.duplicates',
  'module.clipboard',
  'module.packages',
  'module.envvars',
  'module.events',
  'module.connections',
  'module.uninstall',
];

export function DashboardModule() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const live = isTauri();

  const glance = useAsync(async () => {
    if (!live) return null;
    const rows = await runPowershellJson<Glance>(GLANCE_PS);
    return rows[0] ?? null;
  }, [live]);

  const byTag = new Map(allModules.map((m) => [m.tag, m]));
  const reactor = byTag.get('module.reactor');
  const quick = QUICK_TAGS.map((tag) => byTag.get(tag)).filter(
    (m): m is NonNullable<typeof m> => Boolean(m),
  );

  const glanceRows: { k: string; v: string }[] = glance.data
    ? [
        { k: t('dashboard.os'), v: glance.data.os },
        {
          k: t('dashboard.cpu'),
          v: `${glance.data.cpu} (${glance.data.threads} ${t('dashboard.threads')} · ${glance.data.arch})`,
        },
        { k: t('dashboard.memory'), v: glance.data.ram },
        { k: t('dashboard.gpu'), v: glance.data.gpu },
        { k: t('dashboard.sysDrive'), v: glance.data.sysDrive },
        { k: t('dashboard.uptime'), v: `${glance.data.uptime} (${t('dashboard.since')} ${glance.data.boot})` },
      ]
    : [];

  const glanceCols: Column<{ k: string; v: string }>[] = [
    { key: 'k', header: '', width: 220 },
    { key: 'v', header: '' },
  ];

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini primary" onClick={() => requestPaletteOpen()}>
          ⌕ {t('dashboard.searchAll')}
        </button>
        <button className="mini" onClick={glance.reload}>
          {t('dashboard.refresh')}
        </button>
        <StatusDot ok={live} label={live ? t('dashboard.live') : t('dashboard.preview')} />
      </ModuleToolbar>

      <p className="count-note">{t('dashboard.heroSub')}</p>
      <p className="count-note">
        {t('dashboard.stats', {
          total: allModules.length,
          working: registeredModuleTags.size,
          sections: catalog.length,
        })}
      </p>

      <h3>{t('dashboard.quickTitle')}</h3>
      <div className="fav-rail" style={{ marginBottom: 16 }}>
        {reactor && (
          <button
            className="rail-chip"
            style={{ borderColor: 'var(--web)', color: 'var(--web)' }}
            onClick={() => requestModuleOpen(reactor.tag)}
          >
            <span className="glyph" aria-hidden="true">☢</span>
            <span className="rail-chip-label">★ {pick(reactor.en, reactor.zh, lang)} — {t('dashboard.reactorSub')}</span>
          </button>
        )}
        {quick.map((m) => (
          <button key={m.tag} className="rail-chip" onClick={() => requestModuleOpen(m.tag)}>
            <span className="glyph" aria-hidden="true">{m.glyph || '▢'}</span>
            <span className="rail-chip-label">{pick(m.en, m.zh, lang)}</span>
          </button>
        ))}
      </div>

      <h3>{t('dashboard.glanceTitle')}</h3>
      {live ? (
        <AsyncState loading={glance.loading} error={glance.error}>
          <DataTable columns={glanceCols} rows={glanceRows} rowKey={(r) => r.k} />
        </AsyncState>
      ) : (
        <p className="count-note">{t('dashboard.previewNote')}</p>
      )}
    </div>
  );
}
