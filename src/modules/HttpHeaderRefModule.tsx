import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Direction = 'Request' | 'Response' | 'Both';

interface HeaderInfo {
  name: string;
  dir: Direction;
  category: string;
  descEn: string;
  descZh: string;
  example: string;
}

// Ported verbatim from WinForge Services/HttpHeaderRefService.cs (~80 headers).
const H = (name: string, dir: Direction, category: string, descEn: string, descZh: string, example = ''): HeaderInfo => ({
  name,
  dir,
  category,
  descEn,
  descZh,
  example,
});

const ALL: HeaderInfo[] = [
  // ── Caching ──
  H('Cache-Control', 'Both', 'Caching', 'Directives for caching in requests and responses.', '喺請求同回應入面控制快取行為嘅指令。', 'no-cache, max-age=3600'),
  H('Expires', 'Response', 'Caching', 'Date/time after which the response is stale.', '回應過期嘅日期時間，過咗就當過時。', 'Wed, 21 Oct 2026 07:28:00 GMT'),
  H('Age', 'Response', 'Caching', 'Time in seconds the object has been in a proxy cache.', '物件喺代理快取入面存咗幾多秒。', '3600'),
  H('Pragma', 'Both', 'Caching', "Legacy HTTP/1.0 caching control; mostly 'no-cache'.", '舊 HTTP/1.0 快取控制，多數係 no-cache。', 'no-cache'),
  H('Vary', 'Response', 'Caching', 'Which request headers vary the cached response.', '邊啲請求標頭會令快取回應唔同。', 'Accept-Encoding, User-Agent'),
  H('Warning', 'Both', 'Caching', 'Extra info about possible staleness of a message.', '關於訊息可能過時嘅額外資訊。', '110 - "Response is stale"'),

  // ── Conditional ──
  H('ETag', 'Response', 'Conditional', 'Opaque validator identifying a specific resource version.', '識別某個資源版本嘅驗證標籤。', '"33a64df551"'),
  H('If-Match', 'Request', 'Conditional', 'Apply the request only if the ETag matches.', '只有 ETag 相符先執行呢個請求。', '"33a64df551"'),
  H('If-None-Match', 'Request', 'Conditional', 'Apply only if the ETag does NOT match (cache revalidate).', '只有 ETag 唔相符先執行（用嚟重新驗證快取）。', '"33a64df551"'),
  H('If-Modified-Since', 'Request', 'Conditional', 'Return the resource only if changed since this date.', '資源喺呢個日期之後有改先傳返。', 'Wed, 21 Oct 2026 07:28:00 GMT'),
  H('If-Unmodified-Since', 'Request', 'Conditional', 'Proceed only if the resource is unchanged since this date.', '資源自呢個日期未改過先執行。', 'Wed, 21 Oct 2026 07:28:00 GMT'),
  H('Last-Modified', 'Response', 'Conditional', 'Date/time the resource was last modified.', '資源最後一次修改嘅日期時間。', 'Wed, 21 Oct 2026 07:28:00 GMT'),

  // ── Content ──
  H('Content-Type', 'Both', 'Content', 'The media type of the body (MIME type).', '訊息主體嘅媒體類型（MIME）。', 'application/json; charset=utf-8'),
  H('Content-Length', 'Both', 'Content', 'Size of the body in bytes.', '訊息主體嘅位元組大小。', '348'),
  H('Content-Encoding', 'Both', 'Content', 'Compression applied to the body.', '主體用咗嘅壓縮方式。', 'gzip'),
  H('Content-Language', 'Both', 'Content', 'Natural language(s) of the content.', '內容嘅自然語言。', 'zh-HK, en'),
  H('Content-Disposition', 'Response', 'Content', 'Display inline or as a downloadable attachment.', '內容係內嵌定當附件下載。', 'attachment; filename="report.pdf"'),
  H('Content-Location', 'Response', 'Content', 'Alternate location for the returned data.', '回傳資料嘅另一個位置。', '/documents/report.pdf'),
  H('Content-Range', 'Response', 'Range', 'Where a partial body fits in the full resource.', '部分主體喺整個資源入面嘅位置。', 'bytes 200-1000/67589'),
  H('MIME-Version', 'Both', 'Content', 'MIME protocol version used in the message.', '訊息用嘅 MIME 協定版本。', '1.0'),

  // ── Content negotiation ──
  H('Accept', 'Request', 'Content', 'Media types the client can process.', '客戶端可以處理嘅媒體類型。', 'text/html, application/json'),
  H('Accept-Charset', 'Request', 'Content', 'Character sets the client accepts.', '客戶端接受嘅字元集。', 'utf-8'),
  H('Accept-Encoding', 'Request', 'Content', 'Content encodings (compression) the client accepts.', '客戶端接受嘅內容編碼（壓縮）。', 'gzip, deflate, br'),
  H('Accept-Language', 'Request', 'Content', 'Preferred natural languages for the response.', '回應偏好嘅自然語言。', 'zh-HK, en;q=0.8'),

  // ── Range ──
  H('Accept-Ranges', 'Response', 'Range', 'Indicates the server supports range requests.', '話畀你知伺服器支援分段請求。', 'bytes'),
  H('Range', 'Request', 'Range', 'Request only part of a resource (byte range).', '只請求資源嘅一部分（位元組範圍）。', 'bytes=0-1023'),
  H('If-Range', 'Request', 'Range', 'Range request valid only if the validator matches.', '驗證器相符先當呢個範圍請求有效。', '"33a64df551"'),

  // ── Authentication ──
  H('Authorization', 'Request', 'Auth', 'Credentials to authenticate the client.', '用嚟驗證客戶端身份嘅憑證。', 'Bearer eyJhbGci...'),
  H('WWW-Authenticate', 'Response', 'Auth', 'Authentication scheme the server requires.', '伺服器要求嘅驗證方式。', 'Bearer realm="api"'),
  H('Proxy-Authenticate', 'Response', 'Proxy', 'Authentication scheme required by a proxy.', '代理要求嘅驗證方式。', 'Basic realm="proxy"'),
  H('Proxy-Authorization', 'Request', 'Proxy', 'Credentials to authenticate with a proxy.', '同代理驗證用嘅憑證。', 'Basic aGVsbG8='),

  // ── Cookies ──
  H('Cookie', 'Request', 'Cookies', 'Cookies previously set by the server.', '之前伺服器設定畀你嘅 cookie。', 'sessionId=abc123; theme=dark'),
  H('Set-Cookie', 'Response', 'Cookies', 'Instructs the client to store a cookie.', '叫客戶端儲存一個 cookie。', 'id=a3f; HttpOnly; Secure; SameSite=Lax'),

  // ── CORS ──
  H('Origin', 'Request', 'CORS', 'Origin (scheme+host+port) initiating the request.', '發起請求嘅來源（協定＋主機＋埠）。', 'https://example.com'),
  H('Access-Control-Allow-Origin', 'Response', 'CORS', 'Which origins may access the resource.', '邊啲來源可以存取呢個資源。', '*'),
  H('Access-Control-Allow-Methods', 'Response', 'CORS', 'HTTP methods allowed for cross-origin requests.', '跨來源請求准用嘅 HTTP 方法。', 'GET, POST, PUT, DELETE'),
  H('Access-Control-Allow-Headers', 'Response', 'CORS', 'Request headers allowed in cross-origin requests.', '跨來源請求准用嘅請求標頭。', 'Content-Type, Authorization'),
  H('Access-Control-Allow-Credentials', 'Response', 'CORS', 'Whether cookies/credentials may be sent cross-origin.', '跨來源時可唔可以帶 cookie／憑證。', 'true'),
  H('Access-Control-Expose-Headers', 'Response', 'CORS', 'Response headers scripts may read cross-origin.', '腳本跨來源可以讀嘅回應標頭。', 'X-Request-Id'),
  H('Access-Control-Max-Age', 'Response', 'CORS', 'How long a preflight result may be cached (seconds).', '預檢結果可以快取幾耐（秒）。', '600'),
  H('Access-Control-Request-Method', 'Request', 'CORS', 'Method the actual request will use (preflight).', '實際請求會用嘅方法（預檢）。', 'POST'),
  H('Access-Control-Request-Headers', 'Request', 'CORS', 'Headers the actual request will send (preflight).', '實際請求會送嘅標頭（預檢）。', 'Content-Type'),

  // ── Security ──
  H('Strict-Transport-Security', 'Response', 'Security', 'Force HTTPS for future requests (HSTS).', '強制之後嘅請求用 HTTPS（HSTS）。', 'max-age=31536000; includeSubDomains'),
  H('Content-Security-Policy', 'Response', 'Security', 'Controls which resources the page may load.', '控制頁面可以載入邊啲資源。', "default-src 'self'"),
  H('Content-Security-Policy-Report-Only', 'Response', 'Security', 'Report CSP violations without enforcing them.', '只回報 CSP 違規但唔強制執行。', "default-src 'self'; report-uri /csp"),
  H('X-Content-Type-Options', 'Response', 'Security', 'Disables MIME-type sniffing by the browser.', '禁止瀏覽器亂猜 MIME 類型。', 'nosniff'),
  H('X-Frame-Options', 'Response', 'Security', 'Controls whether the page can be framed (clickjacking).', '控制頁面可唔可以被 iframe 內嵌（防點擊劫持）。', 'DENY'),
  H('X-XSS-Protection', 'Response', 'Security', 'Legacy browser XSS filter control.', '舊瀏覽器 XSS 過濾器控制。', '1; mode=block'),
  H('Referrer-Policy', 'Response', 'Security', 'How much referrer info to send with requests.', '請求時送幾多來源網址資訊。', 'no-referrer-when-downgrade'),
  H('Permissions-Policy', 'Response', 'Security', 'Enable/disable browser features per origin.', '按來源開關瀏覽器功能。', 'geolocation=(), camera=()'),
  H('Cross-Origin-Opener-Policy', 'Response', 'Security', 'Isolates the browsing context from other origins.', '將瀏覽情境同其他來源隔離。', 'same-origin'),
  H('Cross-Origin-Embedder-Policy', 'Response', 'Security', 'Requires resources to opt into being embedded.', '要求資源明確允許被嵌入。', 'require-corp'),
  H('Cross-Origin-Resource-Policy', 'Response', 'Security', 'Limits which origins may embed this resource.', '限制邊啲來源可以嵌入呢個資源。', 'same-site'),
  H('Expect-CT', 'Response', 'Security', 'Enforce Certificate Transparency requirements.', '強制執行憑證透明度要求。', 'max-age=86400, enforce'),
  H('Clear-Site-Data', 'Response', 'Security', 'Instructs the browser to clear stored data.', '叫瀏覽器清除已儲存嘅資料。', '"cache", "cookies", "storage"'),

  // ── Connection ──
  H('Connection', 'Both', 'Connection', 'Control options for the current connection.', '控制當前連線嘅選項。', 'keep-alive'),
  H('Keep-Alive', 'Both', 'Connection', 'Parameters for a persistent connection.', '持久連線嘅參數。', 'timeout=5, max=1000'),
  H('Upgrade', 'Both', 'Connection', 'Ask to switch protocols (e.g. to WebSocket).', '要求轉換協定（例如轉去 WebSocket）。', 'websocket'),
  H('Transfer-Encoding', 'Both', 'Connection', 'Encoding used to transfer the body (e.g. chunked).', '傳送主體用嘅編碼（例如 chunked）。', 'chunked'),
  H('TE', 'Request', 'Connection', 'Transfer encodings the client will accept.', '客戶端接受嘅傳送編碼。', 'trailers, deflate'),
  H('Trailer', 'Both', 'Connection', 'Names header fields sent after a chunked body.', '分塊主體之後會送嘅標頭欄位名。', 'Expires'),
  H('Expect', 'Request', 'Connection', 'Client expects certain server behaviour first.', '客戶端預期伺服器先做某啲行為。', '100-continue'),

  // ── Proxy / routing ──
  H('Host', 'Request', 'Proxy', 'Target host and port of the request.', '請求嘅目標主機同埠。', 'example.com:443'),
  H('Via', 'Both', 'Proxy', 'Intermediate proxies the message passed through.', '訊息經過嘅中間代理。', '1.1 vegur'),
  H('Forwarded', 'Request', 'Proxy', 'Client/proxy info disclosed by proxies.', '代理披露嘅客戶端／代理資訊。', 'for=192.0.2.60; proto=https'),
  H('X-Forwarded-For', 'Request', 'Proxy', 'Originating client IP through proxies.', '經過代理嘅原始客戶端 IP。', '203.0.113.195'),
  H('X-Forwarded-Host', 'Request', 'Proxy', 'Original Host requested by the client.', '客戶端原本請求嘅 Host。', 'example.com'),
  H('X-Forwarded-Proto', 'Request', 'Proxy', 'Original protocol (http/https) used by the client.', '客戶端原本用嘅協定（http／https）。', 'https'),
  H('Max-Forwards', 'Request', 'Proxy', 'Limits proxy hops for TRACE/OPTIONS.', '限制 TRACE／OPTIONS 嘅代理跳數。', '10'),

  // ── Request context ──
  H('User-Agent', 'Request', 'Request', 'Identifies the client software making the request.', '識別發出請求嘅客戶端軟件。', 'Mozilla/5.0 (Windows NT 11.0)'),
  H('Referer', 'Request', 'Request', 'URL of the page that linked to this request.', '連過嚟呢個請求嘅頁面網址。', 'https://example.com/page'),
  H('From', 'Request', 'Request', 'Email address of the human controlling the agent.', '操作呢個用戶端嘅人嘅電郵地址。', 'webmaster@example.com'),
  H('Date', 'Both', 'Connection', 'Date and time the message was originated.', '訊息產生嘅日期同時間。', 'Wed, 21 Oct 2026 07:28:00 GMT'),
  H('DNT', 'Request', 'Request', 'Do Not Track preference of the user.', '使用者嘅唔追蹤（Do Not Track）偏好。', '1'),
  H('Save-Data', 'Request', 'Request', 'Client signals a preference for reduced data use.', '客戶端表示想慳流量。', 'on'),

  // ── Response / status ──
  H('Location', 'Response', 'Response', 'Redirect target or URL of a newly created resource.', '重新導向目標，或新建資源嘅網址。', 'https://example.com/new'),
  H('Server', 'Response', 'Response', 'Software handling the request on the server.', '伺服器處理請求嘅軟件。', 'nginx/1.25.0'),
  H('Retry-After', 'Response', 'Response', 'How long to wait before retrying (503/429).', '重試前要等幾耐（503／429）。', '120'),
  H('Allow', 'Response', 'Response', 'HTTP methods supported by the resource.', '資源支援嘅 HTTP 方法。', 'GET, POST, HEAD'),
  H('Accept-Patch', 'Response', 'Response', 'Media types accepted by a PATCH request.', 'PATCH 請求接受嘅媒體類型。', 'application/json-patch+json'),
  H('Alt-Svc', 'Response', 'Response', 'Advertises alternative services (e.g. HTTP/3).', '宣告替代服務（例如 HTTP/3）。', 'h3=":443"; ma=2592000'),
  H('Link', 'Response', 'Response', 'Typed relationships to other resources.', '同其他資源嘅類型化關係。', '</style.css>; rel=preload'),
  H('Server-Timing', 'Response', 'Response', 'Server-side performance metrics for the response.', '回應嘅伺服器端效能量度。', 'db;dur=53, app;dur=47.2'),

  // ── Misc / conditional behaviour ──
  H('Upgrade-Insecure-Requests', 'Request', 'Security', 'Client prefers upgraded (HTTPS) resources.', '客戶端偏好升級（HTTPS）嘅資源。', '1'),
  H('X-Requested-With', 'Request', 'Request', 'Marks AJAX/XHR requests (de-facto convention).', '標示 AJAX／XHR 請求（慣例）。', 'XMLHttpRequest'),
  H('X-Powered-By', 'Response', 'Response', 'Technology powering the server (often removed).', '驅動伺服器嘅技術（通常會移除）。', 'Express'),
  H('X-Request-Id', 'Both', 'Response', 'Correlation id for tracing a single request.', '追蹤單一請求嘅關聯 id。', 'f47ac10b-58cc-4372'),
];

const ALL_TAG = '__all__';

function categories(): string[] {
  const set = new Set(ALL.map((h) => h.category));
  return [...set].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function filterHeaders(query: string, category: string | null, dir: Direction | null): HeaderInfo[] {
  let q = ALL;
  const needle = query.trim().toLowerCase();
  if (needle) {
    q = q.filter(
      (h) =>
        h.name.toLowerCase().includes(needle) ||
        h.descEn.toLowerCase().includes(needle) ||
        h.descZh.includes(needle),
    );
  }
  if (category) q = q.filter((h) => h.category.toLowerCase() === category.toLowerCase());
  if (dir && dir !== 'Both') q = q.filter((h) => h.dir === dir || h.dir === 'Both');
  return [...q].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

function copyText(h: HeaderInfo): string {
  return h.example ? `${h.name}: ${h.example}` : h.name;
}

// Description i18n key for a header — lower-case name with non-alphanumerics
// collapsed to '_' (e.g. "X-Forwarded-For" → "d_x_forwarded_for").
const descKey = (name: string) => 'httpheaderref.d_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_');

export function HttpHeaderRefModule() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>(ALL_TAG);
  const [direction, setDirection] = useState<string>(ALL_TAG);
  const [status, setStatus] = useState<string | null>(null);

  const cats = useMemo(() => categories(), []);
  const results = useMemo(
    () => filterHeaders(query, category === ALL_TAG ? null : category, direction === ALL_TAG ? null : (direction as Direction)),
    [query, category, direction],
  );

  const dirLabel = (d: Direction) =>
    d === 'Request' ? t('httpheaderref.dirRequest') : d === 'Response' ? t('httpheaderref.dirResponse') : t('httpheaderref.dirBoth');

  const onCopy = (h: HeaderInfo) => {
    const text = copyText(h);
    if (!text) return;
    try {
      navigator.clipboard?.writeText(text);
      setStatus(t('httpheaderref.copied', { text }));
    } catch {
      setStatus(t('httpheaderref.copyFail'));
    }
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0, maxWidth: 1000 }}>
        {t('httpheaderref.blurb')}
      </p>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          style={{ flex: 1, minWidth: 180 }}
          placeholder={t('httpheaderref.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="mod-select" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value={ALL_TAG}>{t('httpheaderref.allCategories')}</option>
          {cats.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="mod-select" value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value={ALL_TAG}>{t('httpheaderref.allDirections')}</option>
          <option value="Request">{t('httpheaderref.dirRequest')}</option>
          <option value="Response">{t('httpheaderref.dirResponse')}</option>
        </select>
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('httpheaderref.count', { shown: results.length, total: ALL.length })}
      </p>

      <div className="dt-wrap" style={{ maxHeight: 460 }}>
        <table className="dt">
          <tbody>
            {results.map((h) => (
              <tr key={h.name} style={{ cursor: 'pointer' }} onClick={() => onCopy(h)}>
                <td style={{ verticalAlign: 'top', padding: '8px 6px' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{h.name}</span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: 'var(--accent, #3b82f6)',
                        color: '#fff',
                      }}
                    >
                      {dirLabel(h.dir)}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: 'var(--card-2, rgba(128,128,128,0.18))',
                        color: 'var(--muted, #888)',
                      }}
                    >
                      {h.category}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--muted, #888)', marginTop: 3 }}>
                    {t(descKey(h.name), { defaultValue: h.descEn })}
                  </div>
                  {h.example && (
                    <div style={{ fontFamily: 'Consolas, monospace', fontSize: 12, color: 'var(--muted, #999)', marginTop: 2, wordBreak: 'break-all' }}>
                      {h.example}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="count-note" style={{ marginTop: 10 }}>
        {status ?? t('httpheaderref.hint')}
      </p>
    </div>
  );
}
