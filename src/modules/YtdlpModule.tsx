import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — in-app media downloader wrapping the yt-dlp CLI (github.com/yt-dlp/yt-dlp).
// Paste URLs, list formats, pick a quality preset or explicit format, choose a folder + template,
// download (audio-only, subtitles, thumbnail/metadata, playlists, sponsorblock, cookies, archive),
// plus self-update and clear-cache. Never throws — everything is guarded.

interface Preset {
  key: string;
  sel: string; // -f selector; '' means audio-only or custom
  audio: boolean;
  custom: boolean;
}

// Keyed presets — sel is the yt-dlp -f value; audio marks audio-only; custom uses the format box/list.
const PRESETS: Preset[] = [
  { key: 'presetBest', sel: 'bv*+ba/b', audio: false, custom: false },
  { key: 'preset1080', sel: 'bv*[height<=1080]+ba/b[height<=1080]', audio: false, custom: false },
  { key: 'preset720', sel: 'bv*[height<=720]+ba/b[height<=720]', audio: false, custom: false },
  { key: 'preset480', sel: 'bv*[height<=480]+ba/b[height<=480]', audio: false, custom: false },
  { key: 'presetAudio', sel: '', audio: true, custom: false },
  { key: 'presetCustom', sel: '', audio: false, custom: true },
];

const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'flac', 'wav', 'best'];
const BROWSERS = ['chrome', 'edge', 'firefox', 'brave', 'opera', 'vivaldi'];

interface FormatRow {
  id: string;
  ext: string;
  res: string;
  note: string;
  raw: string;
}

// Parse the `yt-dlp -F` table defensively (columns shift between versions).
function parseFormats(raw: string): FormatRow[] {
  const list: FormatRow[] = [];
  if (!raw) return list;
  let started = false;
  const lines = raw.replace(/\r/g, '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.length === 0) continue;
    if (!started) {
      if (/^\s*ID\s+EXT/i.test(line)) started = true;
      continue;
    }
    const trimmed = line.replace(/^\s+/, '');
    if (trimmed.startsWith('---') || trimmed.startsWith('[')) continue;
    const cols = trimmed.split(/[ \t]+/).filter((c) => c.length > 0);
    if (cols.length < 2) continue;
    const id = cols[0]!;
    const ext = cols[1]!;
    if (id.length === 0 || id.includes('=')) continue;
    const res = cols.length > 2 ? cols[2]! : '';
    const note = cols.length > 3 ? cols.slice(3).join(' ') : '';
    list.push({ id, ext, res, note, raw: trimmed });
  }
  return list;
}

// Build the yt-dlp argument list for a download from the current UI state.
function buildArgs(o: {
  url: string;
  selector: string;
  outputDir: string;
  template: string;
  audioOnly: boolean;
  audioFormat: string;
  subtitles: boolean;
  subLangs: string;
  embedThumbnail: boolean;
  embedMetadata: boolean;
  playlistItems: string;
  useArchive: boolean;
  archivePath: string;
  sponsorBlock: boolean;
  cookiesBrowser: string;
}): string[] {
  const args: string[] = ['--no-color', '--newline', '--progress'];

  if (o.audioOnly) {
    args.push('-x', '--audio-format', o.audioFormat.trim() || 'mp3');
  } else if (o.selector.trim()) {
    args.push('-f', o.selector.trim());
  }

  if (o.template.trim()) args.push('-o', o.template.trim());
  if (o.outputDir.trim()) args.push('-P', o.outputDir.trim());

  if (o.subtitles) {
    args.push('--write-subs', '--write-auto-subs');
    if (o.subLangs.trim()) args.push('--sub-langs', o.subLangs.trim());
    args.push('--embed-subs');
  }
  if (o.embedThumbnail) args.push('--embed-thumbnail');
  if (o.embedMetadata) args.push('--embed-metadata');

  if (o.playlistItems.trim()) args.push('--playlist-items', o.playlistItems.replace(/\s/g, ''));
  if (o.useArchive && o.archivePath.trim()) args.push('--download-archive', o.archivePath.trim());
  if (o.sponsorBlock) args.push('--sponsorblock-remove', 'all');
  if (o.cookiesBrowser.trim()) args.push('--cookies-from-browser', o.cookiesBrowser.trim());

  args.push(o.url.trim());
  return args;
}

function outText(res: CommandOutput): string {
  return res.stdout || res.stderr || `(exit ${res.code})`;
}

export function YtdlpModule() {
  const { t } = useTranslation();

  const [urls, setUrls] = useState('');
  const [formats, setFormats] = useState<FormatRow[] | null>(null);
  const [selectedFmt, setSelectedFmt] = useState('bv*+ba/b');
  const [presetKey, setPresetKey] = useState('presetBest');
  const [audioFormat, setAudioFormat] = useState('mp3');
  const [cookies, setCookies] = useState('');
  const [subtitles, setSubtitles] = useState(false);
  const [subLangs, setSubLangs] = useState('en,zh');
  const [embedThumb, setEmbedThumb] = useState(false);
  const [embedMeta, setEmbedMeta] = useState(false);
  const [sponsor, setSponsor] = useState(false);
  const [archive, setArchive] = useState(false);
  const [playlist, setPlaylist] = useState('');
  const [folder, setFolder] = useState('');
  const [template, setTemplate] = useState('%(title)s [%(id)s].%(ext)s');
  const [log, setLog] = useState('');
  const [busy, setBusy] = useState('');

  const preset = PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0]!;
  const isCustom = preset.custom;
  const isAudio = preset.audio;

  const appendLog = (text: string) => {
    if (!text) return;
    setLog((prev) => {
      const next = prev.length > 400000 ? prev.slice(prev.length - 200000) : prev;
      return next + text + '\n';
    });
  };

  const firstUrl = (): string => {
    const lines = urls.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    return lines.length > 0 ? lines[0]! : '';
  };

  const onPresetChange = (key: string) => {
    setPresetKey(key);
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    if (!p.custom && !p.audio) setSelectedFmt(p.sel);
    else if (p.audio) setSelectedFmt('');
  };

  const onSelectFormat = (row: FormatRow) => {
    setSelectedFmt(row.id);
    setPresetKey('presetCustom'); // honour the explicit id
  };

  const listFormats = async (path: string) => {
    const url = firstUrl();
    if (url.length === 0) return;
    setBusy('formats');
    setFormats(null);
    appendLog(`$ yt-dlp -F ${url}`);
    try {
      const res = await runCommand(path, ['--no-color', '-F', url]);
      const raw = res.stdout || res.stderr || '';
      const parsed = parseFormats(raw);
      setFormats(parsed);
      appendLog(raw);
    } catch (e) {
      appendLog(String(e instanceof Error ? e.message : e));
      setFormats([]);
    } finally {
      setBusy('');
    }
  };

  const download = async (path: string) => {
    const list = urls.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
    if (list.length === 0) return;
    const dir = folder.trim();
    if (dir.length === 0) return;

    setBusy('download');
    const total = list.length;
    let anyFail = false;
    for (let i = 0; i < list.length; i++) {
      const url = list[i]!;
      appendLog(`\n$ yt-dlp … ${url}  (${i + 1}/${total})`);
      const args = buildArgs({
        url,
        selector: isAudio ? '' : selectedFmt,
        outputDir: dir,
        template,
        audioOnly: isAudio,
        audioFormat,
        subtitles,
        subLangs,
        embedThumbnail: embedThumb,
        embedMetadata: embedMeta,
        playlistItems: playlist,
        useArchive: archive,
        archivePath: `${dir.replace(/[\\/]+$/, '')}\\yt-dlp-archive.txt`,
        sponsorBlock: sponsor,
        cookiesBrowser: cookies,
      });
      try {
        const res = await runCommand(path, args);
        appendLog(outText(res));
        if (!res.success) anyFail = true;
      } catch (e) {
        appendLog(String(e instanceof Error ? e.message : e));
        anyFail = true;
      }
    }
    appendLog(anyFail ? t('ytdlp.finishedErrors') : t('ytdlp.allComplete'));
    setBusy('');
  };

  const runMaint = async (path: string, kind: 'update' | 'cache') => {
    setBusy(kind);
    const args = kind === 'update' ? ['-U'] : ['--rm-cache-dir'];
    appendLog(`$ yt-dlp ${args.join(' ')}`);
    try {
      const res = await runCommand(path, args);
      appendLog(outText(res));
    } catch (e) {
      appendLog(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy('');
    }
  };

  const running = busy.length > 0;

  return (
    <div className="mod">
      <p className="count-note">{t('ytdlp.blurb')}</p>
      <DependencyGate tool="yt-dlp" preferId="yt-dlp.yt-dlp" query="yt-dlp">
        {(path) => (
          <>
            <div className="panel">
              <label className="label">{t('ytdlp.urlLabel')}</label>
              <textarea
                className="hosts-edit"
                rows={3}
                placeholder={t('ytdlp.urlPlaceholder')}
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
              />
              <div className="mod-toolbar" style={{ marginTop: 6 }}>
                <button className="mini" disabled={running} onClick={() => listFormats(path)}>
                  {busy === 'formats' ? t('ytdlp.listing') : t('ytdlp.listFormats')}
                </button>
              </div>
            </div>

            {formats && (
              <div className="panel">
                <label className="label">{t('ytdlp.formatsLabel')}</label>
                <p className="count-note" style={{ marginTop: 0 }}>{t('ytdlp.formatsHint')}</p>
                {formats.length === 0 ? (
                  <p className="count-note">{t('ytdlp.noFormats')}</p>
                ) : (
                  <div className="dt-wrap">
                    <table className="dt">
                      <thead>
                        <tr>
                          <th>{t('ytdlp.colId')}</th>
                          <th>{t('ytdlp.colExt')}</th>
                          <th>{t('ytdlp.colRes')}</th>
                          <th>{t('ytdlp.colNote')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {formats.map((f, i) => (
                          <tr
                            key={`${f.id}-${i}`}
                            onClick={() => onSelectFormat(f)}
                            style={{ cursor: 'pointer' }}
                          >
                            <td style={{ fontFamily: 'monospace' }}>{f.id}</td>
                            <td>{f.ext}</td>
                            <td>{f.res}</td>
                            <td>{f.note}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="count-note">{t('ytdlp.formatCount', { count: formats.length })}</p>
              </div>
            )}

            <div className="panel">
              <label className="label">{t('ytdlp.optionsLabel')}</label>
              <div className="io-grid">
                <div className="kv-row">
                  <span className="label">{t('ytdlp.qualityPreset')}</span>
                  <select
                    className="mod-select"
                    value={presetKey}
                    onChange={(e) => onPresetChange(e.target.value)}
                  >
                    {PRESETS.map((p) => (
                      <option key={p.key} value={p.key}>{t(`ytdlp.${p.key}`)}</option>
                    ))}
                  </select>
                </div>
                <div className="kv-row">
                  <span className="label">{t('ytdlp.audioFormat')}</span>
                  <select
                    className="mod-select"
                    value={audioFormat}
                    disabled={!isAudio}
                    onChange={(e) => setAudioFormat(e.target.value)}
                  >
                    {AUDIO_FORMATS.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </div>
                <div className="kv-row">
                  <span className="label">{t('ytdlp.formatId')}</span>
                  <input
                    className="mod-search"
                    value={selectedFmt}
                    disabled={!isCustom}
                    onChange={(e) => setSelectedFmt(e.target.value)}
                  />
                </div>
                <div className="kv-row">
                  <span className="label">{t('ytdlp.cookiesFromBrowser')}</span>
                  <select
                    className="mod-select"
                    value={cookies}
                    onChange={(e) => setCookies(e.target.value)}
                  >
                    <option value="">{t('ytdlp.none')}</option>
                    {BROWSERS.map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </div>
                <div className="kv-row">
                  <span className="label">{t('ytdlp.playlistItems')}</span>
                  <input
                    className="mod-search"
                    placeholder="1-5,8"
                    value={playlist}
                    onChange={(e) => setPlaylist(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <label className="chk">
                  <input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} />
                  {t('ytdlp.downloadSubtitles')}
                </label>
                {subtitles && (
                  <input
                    className="mod-search"
                    style={{ marginLeft: 8, maxWidth: 140 }}
                    placeholder="en,zh"
                    value={subLangs}
                    onChange={(e) => setSubLangs(e.target.value)}
                  />
                )}
                <label className="chk">
                  <input type="checkbox" checked={embedThumb} onChange={(e) => setEmbedThumb(e.target.checked)} />
                  {t('ytdlp.embedThumbnail')}
                </label>
                <label className="chk">
                  <input type="checkbox" checked={embedMeta} onChange={(e) => setEmbedMeta(e.target.checked)} />
                  {t('ytdlp.embedMetadata')}
                </label>
                <label className="chk">
                  <input type="checkbox" checked={sponsor} onChange={(e) => setSponsor(e.target.checked)} />
                  {t('ytdlp.removeSponsor')}
                </label>
                <label className="chk">
                  <input type="checkbox" checked={archive} onChange={(e) => setArchive(e.target.checked)} />
                  {t('ytdlp.useArchive')}
                </label>
              </div>
            </div>

            <div className="panel">
              <label className="label">{t('ytdlp.outputLabel')}</label>
              <div className="io-grid">
                <div className="kv-row">
                  <span className="label">{t('ytdlp.folder')}</span>
                  <input
                    className="mod-search"
                    placeholder={t('ytdlp.folderPlaceholder')}
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                  />
                </div>
                <div className="kv-row">
                  <span className="label">{t('ytdlp.template')}</span>
                  <input
                    className="mod-search"
                    value={template}
                    onChange={(e) => setTemplate(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="mod-toolbar">
              <button className="mini primary" disabled={running} onClick={() => download(path)}>
                {busy === 'download' ? t('ytdlp.downloading') : t('ytdlp.download')}
              </button>
              <button className="mini" disabled={running} onClick={() => runMaint(path, 'update')}>
                {busy === 'update' ? t('ytdlp.updating') : t('ytdlp.updateYtdlp')}
              </button>
              <button className="mini" disabled={running} onClick={() => runMaint(path, 'cache')}>
                {busy === 'cache' ? t('ytdlp.clearingCache') : t('ytdlp.clearCache')}
              </button>
            </div>

            <p className="count-note">{t('ytdlp.ffmpegNote')}</p>

            {log && (
              <div className="panel">
                <div className="mod-toolbar">
                  <label className="label" style={{ flex: 1 }}>{t('ytdlp.logLabel')}</label>
                  <button className="mini" onClick={() => setLog('')}>{t('ytdlp.clearLog')}</button>
                </div>
                <pre className="cmd-out">{log}</pre>
              </div>
            )}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
