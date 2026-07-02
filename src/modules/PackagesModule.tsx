import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand } from '../tauri/bridge';

// winget's output is a fixed-width text table (no stable JSON for search/list),
// so we run it and show the output. Install/upgrade actually execute.
export function PackagesModule() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [installId, setInstallId] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasWinget, setHasWinget] = useState<boolean | null>(null);

  const run = async (args: string[]) => {
    setBusy(true);
    setOut(`> winget ${args.join(' ')}\n`);
    try {
      const res = await runCommand('winget', [...args, '--disable-interactivity']);
      setOut(`> winget ${args.join(' ')}\n\n${res.stdout || res.stderr || `(exit ${res.code})`}`);
    } catch (e) {
      setOut(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    runCommand('winget', ['--version'])
      .then((r) => setHasWinget(r.success))
      .catch(() => setHasWinget(false));
  }, []);

  return (
    <div className="mod">
      <div className="mod-toolbar">
        <button className="mini" disabled={busy} onClick={() => run(['list'])}>
          {t('pkg.listInstalled')}
        </button>
        <button className="mini" disabled={busy} onClick={() => run(['upgrade'])}>
          {t('pkg.upgradable')}
        </button>
      </div>
      <div className="mod-form">
        <input
          className="mod-search"
          placeholder={t('pkg.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && query.trim() && run(['search', query.trim()])}
        />
        <button className="mini primary" disabled={busy || !query.trim()} onClick={() => run(['search', query.trim()])}>
          {t('pkg.search')}
        </button>
      </div>
      <div className="mod-form">
        <input
          className="mod-search"
          style={{ maxWidth: 320 }}
          placeholder={t('pkg.installPlaceholder')}
          value={installId}
          onChange={(e) => setInstallId(e.target.value)}
        />
        <button
          className="mini"
          disabled={busy || !installId.trim()}
          onClick={() =>
            run(['install', '--id', installId.trim(), '-e', '--accept-source-agreements', '--accept-package-agreements'])
          }
        >
          {t('pkg.install')}
        </button>
      </div>
      {hasWinget === false && <p className="mod-msg">{t('pkg.noWinget')}</p>}
      {busy && <p className="count-note">{t('pkg.working')}</p>}
      {out && <pre className="cmd-out">{out}</pre>}
    </div>
  );
}
