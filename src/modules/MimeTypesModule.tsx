import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Extension (with leading dot, lower-case) -> MIME type. Curated common set (~150),
// ported verbatim from WinForge's MimeTypesService.cs.
const MAP: Record<string, string> = {
  // Text & code
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.jsonld': 'application/ld+json',
  '.map': 'application/json',
  '.xml': 'application/xml',
  '.rss': 'application/rss+xml',
  '.atom': 'application/atom+xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.rtf': 'application/rtf',
  '.vtt': 'text/vtt',
  '.ics': 'text/calendar',
  '.vcf': 'text/vcard',
  '.tsv': 'text/tab-separated-values',
  '.log': 'text/plain',
  '.cs': 'text/plain',
  '.c': 'text/plain',
  '.h': 'text/plain',
  '.cpp': 'text/plain',
  '.py': 'text/x-python',
  '.rb': 'text/plain',
  '.go': 'text/plain',
  '.rs': 'text/plain',
  '.java': 'text/plain',
  '.php': 'application/x-httpd-php',
  '.sh': 'application/x-sh',
  '.ps1': 'text/plain',
  '.bat': 'text/plain',
  '.sql': 'application/sql',

  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.svgz': 'image/svg+xml',
  '.ico': 'image/vnd.microsoft.icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.jxl': 'image/jxl',
  '.psd': 'image/vnd.adobe.photoshop',
  '.apng': 'image/apng',
  '.cur': 'image/x-icon',
  '.dds': 'image/vnd-ms.dds',

  // Audio
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.weba': 'audio/webm',
  '.flac': 'audio/flac',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.amr': 'audio/amr',

  // Video
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.mkv': 'video/x-matroska',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
  '.flv': 'video/x-flv',
  '.ts': 'video/mp2t',

  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',

  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.epub': 'application/epub+zip',
  '.mobi': 'application/x-mobipocket-ebook',
  '.azw': 'application/vnd.amazon.ebook',

  // Archives & packages
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.xz': 'application/x-xz',
  '.zst': 'application/zstd',
  '.jar': 'application/java-archive',
  '.apk': 'application/vnd.android.package-archive',
  '.deb': 'application/vnd.debian.binary-package',
  '.rpm': 'application/x-rpm',
  '.cab': 'application/vnd.ms-cab-compressed',
  '.iso': 'application/x-iso9660-image',

  // Windows / executables
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dll': 'application/vnd.microsoft.portable-executable',
  '.msi': 'application/x-msi',
  '.msix': 'application/msix',
  '.appx': 'application/appx',
  '.lnk': 'application/x-ms-shortcut',
  '.reg': 'text/plain',
  '.wasm': 'application/wasm',

  // Data / misc
  '.bin': 'application/octet-stream',
  '.dat': 'application/octet-stream',
  '.pfx': 'application/x-pkcs12',
  '.p12': 'application/x-pkcs12',
  '.cer': 'application/pkix-cert',
  '.crt': 'application/x-x509-ca-cert',
  '.pem': 'application/x-pem-file',
  '.der': 'application/x-x509-ca-cert',
  '.torrent': 'application/x-bittorrent',
  '.gpx': 'application/gpx+xml',
  '.kml': 'application/vnd.google-earth.kml+xml',
  '.webmanifest': 'application/manifest+json',
  '.sqlite': 'application/vnd.sqlite3',
  '.db': 'application/octet-stream',
};

type MimeRow = { ext: string; mime: string };

// All rows, sorted by extension (case-insensitive), matching WinForge's All().
const ALL: MimeRow[] = Object.entries(MAP)
  .map(([ext, mime]) => ({ ext, mime }))
  .sort((a, b) => a.ext.toLowerCase().localeCompare(b.ext.toLowerCase()));

const COUNT = ALL.length;

// Filter rows by a query: matches extension (with or without leading dot) or MIME substring.
function search(query: string): MimeRow[] {
  const q = query.trim();
  if (q.length === 0) return ALL;
  const ql = q.toLowerCase();
  const qNoDot = ql.replace(/^\.+/, '');
  return ALL.filter((r) => {
    const extLower = r.ext.toLowerCase();
    const extNoDot = extLower.replace(/^\.+/, '');
    const mime = r.mime.toLowerCase();
    return extLower.includes(ql) || extNoDot.includes(qNoDot) || mime.includes(ql);
  });
}

// Look up the MIME type for a bare extension (".png" or "png"). null if unknown.
function forExtension(ext: string): string | null {
  let e = ext.trim().toLowerCase();
  if (e.length === 0) return null;
  if (!e.startsWith('.')) e = '.' + e;
  return MAP[e] ?? null;
}

// Extract the final extension (with leading dot) from a filename/path, or '' if none.
function getExtension(filename: string): string {
  // Take the last path segment (handles both / and \ separators).
  const seg = filename.split(/[\\/]/).pop() ?? '';
  const dot = seg.lastIndexOf('.');
  if (dot <= 0) return ''; // no dot, or leading-dot "dotfile" with no extension
  return seg.slice(dot);
}

// Detect the MIME type from a filename or path. Falls back to
// "application/octet-stream" for a known-but-unmapped extension, or null when
// there's no usable extension.
function detectFromFilename(filename: string): string | null {
  const f = filename.trim();
  if (f.length === 0) return null;
  const ext = getExtension(f);
  if (ext === '' || ext === '.') return null;
  return forExtension(ext) ?? 'application/octet-stream';
}

export function MimeTypesModule() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [detect, setDetect] = useState('');
  const [searchMsg, setSearchMsg] = useState('');
  const [detectMsg, setDetectMsg] = useState('');

  const results = useMemo(() => search(query), [query]);
  const detected = useMemo(() => detectFromFilename(detect), [detect]);

  const copyMime = (mime: string) => {
    if (!mime) return;
    void navigator.clipboard?.writeText(mime);
    setSearchMsg(t('mimetypes.copiedPrefix', { mime }));
  };

  const copyDetected = () => {
    if (!detected) return;
    void navigator.clipboard?.writeText(detected);
    setDetectMsg(t('mimetypes.copiedPrefix', { mime: detected }));
  };

  // Detect result text: mirror WinForge's three states.
  const detectText = detectMsg
    ? detectMsg
    : detect.trim().length === 0
      ? t('mimetypes.detectPrompt')
      : detected === null
        ? t('mimetypes.noExt')
        : detected;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mimetypes.blurb', { total: COUNT })}
      </p>

      {/* Search / filter card */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '4px 0 6px' }}>
        {t('mimetypes.searchTitle')}
      </h3>
      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1 }}
          value={query}
          placeholder={t('mimetypes.searchPlaceholder')}
          onChange={(e) => {
            setQuery(e.target.value);
            setSearchMsg('');
          }}
        />
      </div>
      <p className="count-note" style={{ marginTop: 6 }}>
        {searchMsg || t('mimetypes.matches', { n: results.length })}
      </p>
      <div className="dt-wrap" style={{ maxHeight: 360 }}>
        <table className="dt">
          <tbody>
            {results.map((r) => (
              <tr key={r.ext} style={{ cursor: 'pointer' }} onClick={() => copyMime(r.mime)}>
                <td style={{ width: 120, fontFamily: 'monospace', fontWeight: 600 }}>{r.ext}</td>
                <td className="env-val">{r.mime}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="count-note">{t('mimetypes.copyHint')}</p>

      {/* Detect-from-filename card */}
      <h3 className="group-title" style={{ fontSize: 15, margin: '16px 0 6px' }}>
        {t('mimetypes.detectTitle')}
      </h3>
      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1 }}
          value={detect}
          placeholder={t('mimetypes.detectPlaceholder')}
          onChange={(e) => {
            setDetect(e.target.value);
            setDetectMsg('');
          }}
        />
        <button className="mini" disabled={!detected} onClick={copyDetected}>
          {t('mimetypes.copy')}
        </button>
      </div>
      <p className="count-note" style={{ marginTop: 6, fontFamily: 'monospace', fontSize: 13 }}>
        {detectText}
      </p>
    </div>
  );
}
