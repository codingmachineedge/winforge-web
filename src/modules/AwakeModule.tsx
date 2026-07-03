import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { ModuleToolbar, StatusDot } from './common';
import { isTauri } from '../tauri/bridge';

// Port of WinForge Pages/AwakeModule + Services/AwakeService (PowerToys Awake
// style). The Rust backend holds SetThreadExecutionState on a dedicated
// worker thread (src-tauri/src/awake.rs), so the request survives page
// changes and an optional timer auto-reverts to the normal power plan.

interface AwakeStatus {
  active: boolean;
  display: boolean;
  remaining_secs: number | null;
}

export function AwakeModule() {
  const { t } = useTranslation();
  const live = isTauri();
  const [status, setStatus] = useState<AwakeStatus>({ active: false, display: false, remaining_secs: null });
  const [keepDisplay, setKeepDisplay] = useState(false);
  const [minutes, setMinutes] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Poll while active so the countdown ticks and auto-off is reflected.
  useEffect(() => {
    if (!live) return;
    let stop = false;
    const poll = () => {
      invoke<AwakeStatus>('awake_status').then((s) => {
        if (!stop) setStatus(s);
      }, () => {});
    };
    poll();
    const id = setInterval(poll, status.active ? 1000 : 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [live, status.active]);

  const set = (active: boolean, display = keepDisplay) => {
    if (!live) return;
    invoke<AwakeStatus>('awake_set', { active, display, minutes: minutes > 0 ? minutes : null }).then(
      (s) => {
        setStatus(s);
        setError(null);
      },
      (e) => setError(String(e)),
    );
  };

  const fmtRemaining = (secs: number) =>
    `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

  const statusLine = !status.active
    ? t('awake.statusOff')
    : status.remaining_secs != null
      ? t('awake.statusTimed', { time: fmtRemaining(status.remaining_secs) })
      : t('awake.statusOn');

  return (
    <div className="mod">
      <ModuleToolbar>
        <StatusDot ok={status.active} label={status.active ? t('awake.on') : t('awake.off')} />
      </ModuleToolbar>
      <p className="count-note">{t('awake.blurb')}</p>
      {error && <pre className="cmd-out error">{error}</pre>}
      {live ? (
        <>
          <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <strong>{t('awake.toggle')}</strong>
              <div className="count-note" style={{ margin: 0 }}>{statusLine}</div>
            </div>
            <button
              className={`mini${status.active ? ' primary' : ''}`}
              aria-pressed={status.active}
              onClick={() => set(!status.active)}
            >
              {status.active ? t('awake.on') : t('awake.off')}
            </button>
          </div>

          <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <strong>{t('awake.display')}</strong>
              <div className="count-note" style={{ margin: 0 }}>{t('awake.displayDesc')}</div>
            </div>
            <button
              className={`mini${keepDisplay ? ' primary' : ''}`}
              aria-pressed={keepDisplay}
              onClick={() => {
                const v = !keepDisplay;
                setKeepDisplay(v);
                if (status.active) set(true, v);
              }}
            >
              {keepDisplay ? t('awake.on') : t('awake.off')}
            </button>
          </div>

          <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <strong>{t('awake.timer')}</strong>
              <div className="count-note" style={{ margin: 0 }}>{t('awake.timerDesc')}</div>
            </div>
            <input
              type="number"
              min={0}
              max={1440}
              value={minutes}
              onChange={(e) => setMinutes(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))}
              style={{ width: 90 }}
            />
          </div>
        </>
      ) : (
        <p className="count-note">{t('awake.previewNote')}</p>
      )}
    </div>
  );
}
