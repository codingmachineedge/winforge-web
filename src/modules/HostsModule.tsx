import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell } from '../tauri/bridge';

const HOSTS = '$env:SystemRoot\\System32\\drivers\\etc\\hosts';

export function HostsModule() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [orig, setOrig] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const res = await runPowershell(`Get-Content "${HOSTS}" -Raw -ErrorAction SilentlyContinue`);
      setText(res.stdout);
      setOrig(res.stdout);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    setMsg(null);
    // Write via a base64 round-trip to avoid quoting issues; needs admin.
    const b64 = btoa(unescape(encodeURIComponent(text)));
    const script = `$b=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')); Set-Content -Path "${HOSTS}" -Value $b -Encoding utf8 -ErrorAction Stop; 'ok'`;
    try {
      const res = await runPowershell(script);
      if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
      setMsg(t('hosts.saved'));
      setOrig(text);
    } catch (e) {
      setMsg(`${t('hosts.failed')}: ${String(e)}`);
    }
  };

  const flush = async () => {
    setMsg(null);
    const res = await runPowershell('ipconfig /flushdns | Out-String');
    setMsg(res.stdout.trim() || t('hosts.flushed'));
  };

  const dirty = text !== orig;

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <button className="mini" onClick={load}>
          ⟳ {t('modules.refresh')}
        </button>
        <button className="mini primary" disabled={!dirty} onClick={save}>
          {t('hosts.save')}
        </button>
        <button className="mini" onClick={flush}>
          {t('hosts.flush')}
        </button>
        {dirty && <span className="count-note">{t('hosts.unsaved')}</span>}
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('hosts.adminNote')}
      </p>
      {msg && <p className="mod-msg">{msg}</p>}
      <textarea
        className="hosts-edit"
        spellCheck={false}
        value={loading ? t('modules.loading') : text}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}
