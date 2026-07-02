import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveTool, findInstall, installPackage, type ToolResolution, type PackageHit } from '../tauri/deps';
import { useAsync } from './common';

interface Props {
  /** CLI tool name to resolve, e.g. "nmap", "git", "docker". */
  tool: string;
  /** Preferred winget id tried before a fuzzy search, e.g. "Git.Git". */
  preferId?: string;
  /** Search query for the installer (defaults to `tool`). */
  query?: string;
  /** Rendered with the resolved tool path once the tool is available. */
  children: (path: string) => ReactNode;
}

/**
 * Gates a module on an external CLI tool. If the tool is bundled or on PATH the
 * children render. If missing, it offers to locate an installer — winget first,
 * Chocolatey fallback — and install it, then re-resolves.
 */
export function DependencyGate({ tool, preferId, query, children }: Props) {
  const { t } = useTranslation();
  const { data, loading, reload } = useAsync<ToolResolution>(() => resolveTool(tool), [tool]);
  const [hit, setHit] = useState<PackageHit | null>(null);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  if (loading) return <p className="count-note">{t('modules.loading')}</p>;

  if (data && data.path) {
    return (
      <>
        <p className="dep-ok">
          ✓ {t('deps.found', { tool })} · <span className="dep-src">{data.source}</span> ·{' '}
          <code>{data.path}</code>
        </p>
        {children(data.path)}
      </>
    );
  }

  const search = async () => {
    setSearching(true);
    setMsg(null);
    setSearched(false);
    try {
      const found = await findInstall(query ?? tool, preferId);
      setHit(found);
      setSearched(true);
      if (!found) setMsg(t('deps.none', { tool }));
    } finally {
      setSearching(false);
    }
  };

  const install = async () => {
    if (!hit) return;
    setInstalling(true);
    setMsg(t('deps.installing', { id: hit.id, mgr: hit.manager }));
    try {
      const res = await installPackage(hit);
      setMsg(res.success ? t('deps.installed', { id: hit.id }) : res.stderr.trim() || `exit ${res.code}`);
      reload();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="dep-gate">
      <p className="dep-missing">⚠ {t('deps.missing', { tool })}</p>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('deps.resolveNote')}
      </p>
      <div className="mod-toolbar">
        <button className="mini primary" disabled={searching} onClick={search}>
          {searching ? t('deps.searching') : t('deps.find')}
        </button>
        {hit && (
          <button className="mini" disabled={installing} onClick={install}>
            {t('deps.installVia', { mgr: hit.manager, id: hit.id })}
          </button>
        )}
        <button className="mini" onClick={reload}>
          ⟳ {t('deps.recheck')}
        </button>
      </div>
      {hit && (
        <p className="dep-hit">
          <span className={`mgr-badge ${hit.manager}`}>{hit.manager}</span> <code>{hit.id}</code>
          {hit.version ? ` · ${hit.version}` : ''}
        </p>
      )}
      {searched && !hit && (
        <p className="count-note">
          {t('deps.none', { tool })}{' '}
          <a href={`https://winget.run/search?query=${encodeURIComponent(tool)}`} target="_blank" rel="noreferrer">
            winget.run
          </a>{' '}
          ·{' '}
          <a href={`https://community.chocolatey.org/packages?q=${encodeURIComponent(tool)}`} target="_blank" rel="noreferrer">
            chocolatey.org
          </a>
        </p>
      )}
      {msg && <pre className="cmd-out">{msg}</pre>}
    </div>
  );
}
