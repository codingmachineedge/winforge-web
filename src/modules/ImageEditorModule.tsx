import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershellJson } from '../tauri/bridge';
import { AsyncState, Column, DataTable, ModuleToolbar, useAsync } from './common';

interface Img {
  Name: string;
  Path: string;
  Folder: string;
  Ext: string;
  Bytes: number;
  Width: number;
  Height: number;
  Modified: string;
}

// Scan the user's real picture folders on disk and read true pixel dimensions
// from each image via System.Drawing (managed, in-process — no external tool).
const SCAN = `
Add-Type -AssemblyName System.Drawing
$roots = @(
  [Environment]::GetFolderPath('MyPictures'),
  (Join-Path $env:USERPROFILE 'Pictures'),
  (Join-Path $env:USERPROFILE 'Downloads'),
  (Join-Path $env:USERPROFILE 'Desktop')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
$exts = '.png','.jpg','.jpeg','.bmp','.gif','.webp','.tif','.tiff'
$files = foreach ($r in $roots) {
  Get-ChildItem -LiteralPath $r -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $exts -contains $_.Extension.ToLower() }
}
$files | Sort-Object LastWriteTime -Descending | Select-Object -First 400 | ForEach-Object {
  $w = 0; $h = 0
  try {
    $img = [System.Drawing.Image]::FromFile($_.FullName)
    $w = $img.Width; $h = $img.Height
    $img.Dispose()
  } catch { }
  [PSCustomObject]@{
    Name     = $_.Name
    Path     = $_.FullName
    Folder   = $_.DirectoryName
    Ext      = $_.Extension.TrimStart('.').ToLower()
    Bytes    = [int64]$_.Length
    Width    = [int]$w
    Height   = [int]$h
    Modified = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
  }
}`;

// Vocabulary carried over from the WinForge desktop raster editor (P("en","粵語")).
const FILTERS = ['grayscale', 'invert', 'sepia', 'blur', 'sharpen', 'edge'] as const;
const ADJUSTS = ['brightness', 'contrast', 'saturation', 'hue', 'gamma'] as const;
const TRANSFORMS = ['rotateCw', 'rotateCcw', 'flipH', 'flipV', 'resize', 'crop'] as const;

export function ImageEditorModule() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const [extSel, setExtSel] = useState('all');

  const { data, loading, error, reload } = useAsync(() => runPowershellJson<Img>(SCAN), []);

  const all = useMemo(() => data ?? [], [data]);

  const extList = useMemo(() => {
    const s = new Set<string>();
    for (const i of all) if (i.Ext) s.add(i.Ext);
    return [...s].sort();
  }, [all]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return all.filter((i) => {
      if (extSel !== 'all' && i.Ext !== extSel) return false;
      if (!q) return true;
      return `${i.Name} ${i.Folder}`.toLowerCase().includes(q);
    });
  }, [all, filter, extSel]);

  const totalBytes = useMemo(() => rows.reduce((a, i) => a + (i.Bytes || 0), 0), [rows]);

  const fmtSize = (b: number) => {
    if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
    if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB`;
    if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${b} B`;
  };

  const mp = (w: number, h: number) => {
    if (w <= 0 || h <= 0) return '—';
    return `${((w * h) / 1_000_000).toFixed(1)} MP`;
  };

  const columns: Column<Img>[] = [
    { key: 'Name', header: t('imageeditor.colName') },
    {
      key: 'Ext',
      header: t('imageeditor.colFormat'),
      width: 80,
      render: (i) => <span className="mono">{i.Ext.toUpperCase()}</span>,
    },
    {
      key: 'dim',
      header: t('imageeditor.colDim'),
      width: 120,
      render: (i) => (i.Width > 0 ? `${i.Width} × ${i.Height}` : '—'),
    },
    {
      key: 'mp',
      header: t('imageeditor.colMp'),
      width: 90,
      align: 'right',
      render: (i) => mp(i.Width, i.Height),
    },
    {
      key: 'Bytes',
      header: t('imageeditor.colSize'),
      width: 100,
      align: 'right',
      render: (i) => fmtSize(i.Bytes),
    },
    { key: 'Modified', header: t('imageeditor.colModified'), width: 140 },
    { key: 'Folder', header: t('imageeditor.colFolder') },
  ];

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('imageeditor.blurb')}
      </p>

      <ModuleToolbar>
        <input
          className="mod-search"
          placeholder={t('imageeditor.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select className="mini" value={extSel} onChange={(e) => setExtSel(e.target.value)}>
          <option value="all">{t('imageeditor.allFormats')}</option>
          {extList.map((x) => (
            <option key={x} value={x}>
              {x.toUpperCase()}
            </option>
          ))}
        </select>
        <button className="mini" onClick={reload}>
          ⟳ {t('modules.refresh')}
        </button>
        <span className="count-note">
          {t('imageeditor.count', { num: rows.length })} · {fmtSize(totalBytes)}
        </span>
      </ModuleToolbar>

      <AsyncState loading={loading} error={error}>
        <DataTable columns={columns} rows={rows} rowKey={(i) => i.Path} empty={t('imageeditor.empty')} />
      </AsyncState>

      <div className="mod-cols" style={{ marginTop: 16 }}>
        <section>
          <h4>{t('imageeditor.adjustHeader')}</h4>
          <div className="chip-row">
            {ADJUSTS.map((a) => (
              <span key={a} className="chip">
                {t(`imageeditor.adj_${a}`)}
              </span>
            ))}
          </div>
        </section>
        <section>
          <h4>{t('imageeditor.filterHeader')}</h4>
          <div className="chip-row">
            {FILTERS.map((f) => (
              <span key={f} className="chip">
                {t(`imageeditor.flt_${f}`)}
              </span>
            ))}
          </div>
        </section>
        <section>
          <h4>{t('imageeditor.transformHeader')}</h4>
          <div className="chip-row">
            {TRANSFORMS.map((x) => (
              <span key={x} className="chip">
                {t(`imageeditor.tf_${x}`)}
              </span>
            ))}
          </div>
        </section>
      </div>
      <p className="count-note">{t('imageeditor.editNote')}</p>
    </div>
  );
}
