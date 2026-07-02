import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

export function GitModule() {
  const { t } = useTranslation();
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (gitPath: string) => {
    setBusy(true);
    try {
      const ver = await runCommand(gitPath, ['--version']);
      const name = await runCommand(gitPath, ['config', '--global', 'user.name']);
      const email = await runCommand(gitPath, ['config', '--global', 'user.email']);
      setInfo(
        `${ver.stdout.trim()}\n` +
          `user.name  = ${name.stdout.trim() || '(unset)'}\n` +
          `user.email = ${email.stdout.trim() || '(unset)'}`,
      );
    } catch (e) {
      setInfo(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mod">
      <DependencyGate tool="git" preferId="Git.Git" query="git">
        {(path) => (
          <>
            <div className="mod-toolbar">
              <button className="mini primary" disabled={busy} onClick={() => load(path)}>
                {t('git.showInfo')}
              </button>
            </div>
            {info && <pre className="cmd-out">{info}</pre>}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
