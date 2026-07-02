import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

export function NmapModule() {
  const { t } = useTranslation();
  const [target, setTarget] = useState('scanme.nmap.org');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);

  const scan = async (nmapPath: string) => {
    if (!target.trim()) return;
    setBusy(true);
    setOut(`> nmap -F ${target}\n`);
    try {
      const res = await runCommand(nmapPath, ['-F', target.trim()]);
      setOut(res.stdout || res.stderr || `(exit ${res.code})`);
    } catch (e) {
      setOut(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mod">
      <DependencyGate tool="nmap" preferId="Insecure.Nmap" query="nmap">
        {(path) => (
          <>
            <div className="mod-form">
              <input
                className="mod-search"
                placeholder={t('nmap.target')}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && scan(path)}
              />
              <button className="mini primary" disabled={busy} onClick={() => scan(path)}>
                {busy ? t('nmap.scanning') : t('nmap.scan')}
              </button>
            </div>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('nmap.note')}
            </p>
            {out && <pre className="cmd-out">{out}</pre>}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
