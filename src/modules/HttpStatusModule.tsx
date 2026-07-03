import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface HttpStatus {
  code: number;
  name: string;
  descEn: string;
  descZh: string;
}

// Full offline catalogue ported from WinForge Services/HttpStatusService.cs (1xx–5xx).
const ALL: HttpStatus[] = [
  // 1xx Informational
  { code: 100, name: 'Continue', descEn: 'Request headers received; the client should continue sending the body.', descZh: '已收到請求標頭，客戶端可以繼續傳送主體。' },
  { code: 101, name: 'Switching Protocols', descEn: 'Server agrees to switch protocols as the client requested (e.g. to WebSocket).', descZh: '伺服器同意按客戶端要求轉換協定（例如轉去 WebSocket）。' },
  { code: 102, name: 'Processing', descEn: 'Server has accepted the request but has not finished processing it (WebDAV).', descZh: '伺服器已收到請求但仲未處理完（WebDAV）。' },
  { code: 103, name: 'Early Hints', descEn: 'Preliminary headers sent so the client can start preloading resources.', descZh: '先傳部分標頭，等客戶端可以預先載入資源。' },
  // 2xx Success
  { code: 200, name: 'OK', descEn: 'The request succeeded; the response carries the requested content.', descZh: '請求成功，回應帶住你要嘅內容。' },
  { code: 201, name: 'Created', descEn: 'The request succeeded and a new resource was created.', descZh: '請求成功，並且新開咗一個資源。' },
  { code: 202, name: 'Accepted', descEn: 'The request was accepted for processing, but is not yet complete.', descZh: '請求已收到會處理，但仲未做完。' },
  { code: 203, name: 'Non-Authoritative Information', descEn: 'Returned metadata came from a copy, not the origin server.', descZh: '回傳嘅資料嚟自副本，唔係源伺服器。' },
  { code: 204, name: 'No Content', descEn: 'The request succeeded but there is no content to return.', descZh: '請求成功，但冇內容返俾你。' },
  { code: 205, name: 'Reset Content', descEn: 'Success; the client should reset the document view that sent the request.', descZh: '成功，客戶端應該重設個表單／畫面。' },
  { code: 206, name: 'Partial Content', descEn: 'Only part of the resource is returned, as asked by a Range request.', descZh: '只回傳資源嘅一部分（回應 Range 範圍請求）。' },
  { code: 207, name: 'Multi-Status', descEn: 'Conveys multiple independent status codes for a WebDAV request.', descZh: '一次過回傳多個狀態（WebDAV）。' },
  { code: 208, name: 'Already Reported', descEn: 'Members of a WebDAV binding were already enumerated earlier.', descZh: 'WebDAV 綁定成員之前已經列過。' },
  { code: 226, name: 'IM Used', descEn: 'The response is the result of instance-manipulations applied to the resource.', descZh: '回應係對資源做咗實例操作之後嘅結果。' },
  // 3xx Redirection
  { code: 300, name: 'Multiple Choices', descEn: 'Several responses are available; the client may choose one.', descZh: '有幾個選擇可以揀，由客戶端決定。' },
  { code: 301, name: 'Moved Permanently', descEn: 'The resource has permanently moved to a new URL.', descZh: '資源已經永久搬去新網址。' },
  { code: 302, name: 'Found', descEn: 'The resource is temporarily at a different URL.', descZh: '資源暫時喺另一個網址。' },
  { code: 303, name: 'See Other', descEn: 'Follow up with a GET request to a different URL.', descZh: '去另一個網址用 GET 攞返結果。' },
  { code: 304, name: 'Not Modified', descEn: 'The cached copy is still fresh; no need to resend the body.', descZh: '快取嘅版本仲新，唔使再傳主體。' },
  { code: 305, name: 'Use Proxy', descEn: 'The resource must be accessed through a proxy (deprecated).', descZh: '要經指定代理伺服器先攞到（已棄用）。' },
  { code: 307, name: 'Temporary Redirect', descEn: 'Temporary redirect that keeps the original HTTP method.', descZh: '暫時導向，而且保持原本嘅 HTTP 方法。' },
  { code: 308, name: 'Permanent Redirect', descEn: 'Permanent redirect that keeps the original HTTP method.', descZh: '永久導向，而且保持原本嘅 HTTP 方法。' },
  // 4xx Client Error
  { code: 400, name: 'Bad Request', descEn: 'The server cannot process the request due to a client error.', descZh: '請求有問題，伺服器處理唔到。' },
  { code: 401, name: 'Unauthorized', descEn: 'Authentication is required and has failed or not been provided.', descZh: '要先登入驗證，而家未通過。' },
  { code: 402, name: 'Payment Required', descEn: 'Reserved for future use; sometimes used for paid APIs.', descZh: '預留俾將來用，有時用喺付費 API。' },
  { code: 403, name: 'Forbidden', descEn: 'The server understood the request but refuses to authorize it.', descZh: '伺服器明白請求，但唔俾你做。' },
  { code: 404, name: 'Not Found', descEn: 'The requested resource could not be found on the server.', descZh: '搵唔到你要嘅資源。' },
  { code: 405, name: 'Method Not Allowed', descEn: 'The HTTP method is not supported for this resource.', descZh: '呢個資源唔支援你用嘅 HTTP 方法。' },
  { code: 406, name: 'Not Acceptable', descEn: "No response matches the client's Accept headers.", descZh: '冇符合你 Accept 條件嘅回應。' },
  { code: 407, name: 'Proxy Authentication Required', descEn: 'The client must authenticate with a proxy first.', descZh: '要先向代理伺服器驗證。' },
  { code: 408, name: 'Request Timeout', descEn: 'The server timed out waiting for the request.', descZh: '等你個請求等到逾時。' },
  { code: 409, name: 'Conflict', descEn: 'The request conflicts with the current state of the resource.', descZh: '同資源目前嘅狀態有衝突。' },
  { code: 410, name: 'Gone', descEn: 'The resource is permanently gone and will not return.', descZh: '資源已經永久消失，唔會返嚟。' },
  { code: 411, name: 'Length Required', descEn: 'The server requires a Content-Length header.', descZh: '伺服器要求要有 Content-Length 標頭。' },
  { code: 412, name: 'Precondition Failed', descEn: 'A precondition in the request headers was not met.', descZh: '請求標頭裏面嘅前置條件唔符合。' },
  { code: 413, name: 'Payload Too Large', descEn: 'The request body is larger than the server will accept.', descZh: '請求主體太大，伺服器收唔落。' },
  { code: 414, name: 'URI Too Long', descEn: 'The request URL is longer than the server will process.', descZh: '個網址太長，伺服器處理唔到。' },
  { code: 415, name: 'Unsupported Media Type', descEn: "The request's media type is not supported.", descZh: '唔支援呢種媒體類型。' },
  { code: 416, name: 'Range Not Satisfiable', descEn: 'The requested Range cannot be served.', descZh: '你要嘅 Range 範圍畀唔到。' },
  { code: 417, name: 'Expectation Failed', descEn: 'The server cannot meet the Expect request header.', descZh: '滿足唔到 Expect 標頭嘅要求。' },
  { code: 418, name: "I'm a teapot", descEn: "An April Fools' joke code — the server refuses to brew coffee.", descZh: '愚人節玩笑碼 — 一個茶壺沖唔到咖啡。' },
  { code: 421, name: 'Misdirected Request', descEn: 'The request was routed to a server that cannot respond to it.', descZh: '請求去錯咗一部應付唔到嘅伺服器。' },
  { code: 422, name: 'Unprocessable Entity', descEn: 'The request is well-formed but semantically invalid.', descZh: '格式啱但語意上處理唔到。' },
  { code: 423, name: 'Locked', descEn: 'The resource being accessed is locked (WebDAV).', descZh: '要攞嘅資源被鎖住咗（WebDAV）。' },
  { code: 424, name: 'Failed Dependency', descEn: 'The request failed because a dependent request failed.', descZh: '因為所依賴嘅請求失敗，所以連埋失敗。' },
  { code: 425, name: 'Too Early', descEn: 'The server is unwilling to process a possibly-replayed request.', descZh: '伺服器唔想處理可能被重放嘅請求。' },
  { code: 426, name: 'Upgrade Required', descEn: 'The client should switch to a different protocol.', descZh: '客戶端要升級／轉用另一個協定。' },
  { code: 428, name: 'Precondition Required', descEn: 'The server requires the request to be conditional.', descZh: '伺服器要求請求要帶前置條件。' },
  { code: 429, name: 'Too Many Requests', descEn: 'The client has sent too many requests in a given time.', descZh: '短時間內請求太多次（限速）。' },
  { code: 431, name: 'Request Header Fields Too Large', descEn: 'The header fields are too large to process.', descZh: '標頭欄位太大，處理唔到。' },
  { code: 451, name: 'Unavailable For Legal Reasons', descEn: 'The resource is blocked for legal reasons.', descZh: '因法律原因唔提供呢個資源。' },
  // 5xx Server Error
  { code: 500, name: 'Internal Server Error', descEn: 'A generic error — the server hit an unexpected condition.', descZh: '伺服器出咗個未預料到嘅錯誤。' },
  { code: 501, name: 'Not Implemented', descEn: 'The server does not support the functionality required.', descZh: '伺服器未實作呢個功能。' },
  { code: 502, name: 'Bad Gateway', descEn: 'An upstream server returned an invalid response.', descZh: '上游伺服器回咗個無效回應。' },
  { code: 503, name: 'Service Unavailable', descEn: 'The server is overloaded or down for maintenance.', descZh: '伺服器過載或者維護緊，暫時用唔到。' },
  { code: 504, name: 'Gateway Timeout', descEn: 'An upstream server did not respond in time.', descZh: '上游伺服器遲遲唔回應（逾時）。' },
  { code: 505, name: 'HTTP Version Not Supported', descEn: 'The HTTP version used is not supported.', descZh: '唔支援你用嘅 HTTP 版本。' },
  { code: 506, name: 'Variant Also Negotiates', descEn: 'A content-negotiation configuration error occurred.', descZh: '內容協商設定出錯（循環協商）。' },
  { code: 507, name: 'Insufficient Storage', descEn: 'The server cannot store what is needed to finish (WebDAV).', descZh: '伺服器儲存空間不足，做唔完（WebDAV）。' },
  { code: 508, name: 'Loop Detected', descEn: 'The server detected an infinite loop while processing (WebDAV).', descZh: '處理途中偵測到無限迴圈（WebDAV）。' },
  { code: 510, name: 'Not Extended', descEn: 'Further extensions to the request are required.', descZh: '請求要加額外擴充先處理到。' },
  { code: 511, name: 'Network Authentication Required', descEn: 'The client must authenticate to gain network access.', descZh: '要先做網絡驗證先上到網（如 Wi-Fi 登入頁）。' },
].sort((a, b) => a.code - b.code);

// Leading digit → class (1..5); 0 when out of range.
function category(code: number): number {
  return code >= 100 && code <= 599 ? Math.floor(code / 100) : 0;
}

const CATEGORY_COLOR: Record<number, string> = {
  1: '#6B7B8C', // 1xx grey-blue
  2: '#2E8B57', // 2xx green
  3: '#2B6CB0', // 3xx blue
  4: '#C77D0A', // 4xx amber
  5: '#C0392B', // 5xx red
};

export function HttpStatusModule() {
  const { t, i18n } = useTranslation();
  const isZh = (i18n.language || '').toLowerCase().startsWith('zh');
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(0); // 0 = all, else 1..5
  const [lookup, setLookup] = useState('');
  const [msg, setMsg] = useState('');

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();
    return ALL.filter((s) => {
      if (selectedCategory >= 1 && selectedCategory <= 5 && category(s.code) !== selectedCategory) return false;
      if (term.length === 0) return true;
      return (
        String(s.code).includes(term) ||
        s.name.toLowerCase().includes(term) ||
        s.descEn.toLowerCase().includes(term) ||
        s.descZh.includes(query.trim())
      );
    });
  }, [query, selectedCategory]);

  const onLookup = (raw: string) => {
    setLookup(raw);
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v) || v <= 0) return;
    const hit = ALL.find((s) => s.code === v);
    if (!hit) {
      setMsg(t('httpstatus.noCode', { code: v }));
      return;
    }
    // Show just that code: clear filters and search the exact number.
    setSelectedCategory(0);
    setQuery(String(v));
    setMsg('');
  };

  const clearLookup = () => {
    setLookup('');
    setQuery('');
    setSelectedCategory(0);
    setMsg('');
  };

  const copyRow = (s: HttpStatus) => {
    const text = `${s.code} ${s.name}`.trim();
    void navigator.clipboard?.writeText(text);
    setMsg(t('httpstatus.copied', { text }));
  };

  const status =
    rows.length === 0 ? t('httpstatus.noMatch') : t('httpstatus.showing', { n: rows.length.toLocaleString() });

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('httpstatus.blurb')}
      </p>

      <div className="mod-toolbar">
        <input
          className="mod-search"
          placeholder={t('httpstatus.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="mod-select"
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(parseInt(e.target.value, 10))}
        >
          <option value={0}>{t('httpstatus.allClasses')}</option>
          <option value={1}>{t('httpstatus.cat1')}</option>
          <option value={2}>{t('httpstatus.cat2')}</option>
          <option value={3}>{t('httpstatus.cat3')}</option>
          <option value={4}>{t('httpstatus.cat4')}</option>
          <option value={5}>{t('httpstatus.cat5')}</option>
        </select>
      </div>

      <div className="mod-toolbar">
        <span className="count-note">{t('httpstatus.lookupLabel')}</span>
        <input
          className="mod-search"
          style={{ maxWidth: 120 }}
          type="number"
          min={0}
          max={599}
          value={lookup}
          onChange={(e) => onLookup(e.target.value)}
        />
        <button className="mini" onClick={clearLookup}>
          {t('httpstatus.showAll')}
        </button>
        {msg && <span className="count-note">{msg}</span>}
      </div>

      <p className="count-note" style={{ marginTop: 0 }}>
        {status}
      </p>

      <div className="dt-wrap" style={{ maxHeight: 560 }}>
        <table className="dt">
          <tbody>
            {rows.map((s) => (
              <tr key={s.code} style={{ cursor: 'pointer' }} onClick={() => copyRow(s)} title={t('httpstatus.clickRow')}>
                <td style={{ width: 64 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      minWidth: 46,
                      textAlign: 'center',
                      padding: '3px 8px',
                      borderRadius: 6,
                      color: 'white',
                      fontWeight: 600,
                      fontSize: 13,
                      background: CATEGORY_COLOR[category(s.code)] ?? 'gray',
                    }}
                  >
                    {s.code}
                  </span>
                </td>
                <td>
                  <div style={{ fontWeight: 600 }}>{s.name}</div>
                  <div className="count-note" style={{ marginTop: 2 }}>
                    {isZh ? s.descZh : s.descEn}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
