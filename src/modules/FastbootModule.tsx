import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';
import { ModuleToolbar, StatusDot } from './common';

interface FbDevice {
  serial: string;
  mode: string;
}

// Parse `fastboot devices` output: "<serial>\t<mode>" per line.
function parseDevices(out: string): FbDevice[] {
  const list: FbDevice[] = [];
  for (const raw of out.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('<')) continue;
    const parts = line.split(/[\s\t]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const mode = parts[1];
    if (serial && mode) list.push({ serial, mode });
  }
  return list;
}

// Extract the value from a `getvar` line: "name: value".
function parseVar(out: string, name: string): string {
  for (const raw of out.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const i = line.indexOf(':');
    if (i > 0 && line.substring(0, i).trim().toLowerCase() === name.toLowerCase())
      return line.substring(i + 1).trim();
  }
  return '';
}

type Verb = 'unlock' | 'lock' | 'flashBoot' | 'bootImg' | 'factory' | 'sideload';

interface Pending {
  verb: Verb;
  title: string;
  body: string;
  keyword: string;
  path?: string;
}

function FastbootPanel({ exePath }: { exePath: string }) {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<FbDevice[]>([]);
  const [serial, setSerial] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [pathInput, setPathInput] = useState('');

  const append = useCallback((text: string) => {
    setLog((prev) => (prev.length > 0 ? prev + '\n' : '') + text + '\n');
  }, []);

  // Select-token for a serial: "-s <serial> " or "".
  const sel = (s: string) => (s ? ['-s', s] : []);

  // Run fastboot with args, or return the previewed command string when dry-run.
  const run = useCallback(
    async (args: string[]): Promise<{ preview: string; out: string; ran: boolean }> => {
      const preview = `fastboot ${args.join(' ')}`.trim();
      try {
        const res = await runCommand(exePath, args);
        return { preview, out: (res.stdout || res.stderr || '').trim() || `(exit ${res.code})`, ran: true };
      } catch (e) {
        return { preview, out: String(e), ran: true };
      }
    },
    [exePath],
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await runCommand(exePath, ['devices']).catch((e) => ({ stdout: '', stderr: String(e), code: 1, success: false }));
      const found = parseDevices(res.stdout || '');
      setDevices(found);
      const first = found[0];
      if (first && !found.some((d) => d.serial === serial)) setSerial(first.serial);
      if (found.length === 0) setSerial('');
      if (found.length === 0)
        append(t('fastboot.noDevices'));
    } finally {
      setBusy(false);
    }
  }, [exePath, serial, append, t]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exePath]);

  const getVar = useCallback(
    async (name: string): Promise<string> => {
      const res = await runCommand(exePath, [...sel(serial), 'getvar', name]).catch(() => null);
      // fastboot prints getvar output on stderr.
      const out = res ? `${res.stdout}\n${res.stderr}` : '';
      return parseVar(out, name);
    },
    [exePath, serial],
  );

  const status = useCallback(async () => {
    setBusy(true);
    try {
      const product = await getVar('product');
      const slot = await getVar('current-slot');
      const unlockedRaw = (await getVar('unlocked')).toLowerCase();
      let unlocked: boolean | null = null;
      if (unlockedRaw.includes('yes') || unlockedRaw === 'true') unlocked = true;
      else if (unlockedRaw.includes('no') || unlockedRaw === 'false') unlocked = false;
      const u =
        unlocked === null
          ? t('fastboot.stateUnknown')
          : unlocked
            ? t('fastboot.stateUnlocked')
            : t('fastboot.stateLocked');
      append(
        `── ${t('fastboot.bootloaderStatus')} ──\n` +
          `product: ${product || '?'}\n` +
          `current-slot: ${slot || '?'}\n` +
          `bootloader: ${u}`,
      );
    } finally {
      setBusy(false);
    }
  }, [getVar, append, t]);

  const reboot = useCallback(async () => {
    if (!serial) {
      append(t('fastboot.pickFirst'));
      return;
    }
    const args = [...sel(serial), 'reboot'];
    if (dryRun) {
      append(`[dry-run] fastboot ${args.join(' ')}`);
      return;
    }
    setBusy(true);
    try {
      const r = await run(args);
      append(`✓ ${r.out}`);
      void refresh();
    } finally {
      setBusy(false);
    }
  }, [serial, dryRun, run, append, refresh, t]);

  // Build the fastboot/adb args for a mutating verb.
  const argsFor = (verb: Verb, path: string): string[] => {
    switch (verb) {
      case 'unlock':
        return [...sel(serial), 'flashing', 'unlock'];
      case 'lock':
        return [...sel(serial), 'flashing', 'lock'];
      case 'flashBoot':
        return [...sel(serial), 'flash', 'boot', path];
      case 'bootImg':
        return [...sel(serial), 'boot', path];
      case 'factory':
        return [...sel(serial), 'update', path];
      case 'sideload':
        // Sideload is an adb-recovery op, not fastboot — previewed as such.
        return [...sel(serial), 'sideload', path];
    }
  };

  // Open the typed-confirmation dialog for a dangerous verb.
  const requestAction = (verb: Verb, needsPath: boolean) => {
    if (!serial) {
      append(t('fastboot.pickFirst'));
      return;
    }
    if (needsPath && !pathInput.trim()) {
      append(t('fastboot.needPath'));
      return;
    }
    const path = pathInput.trim();
    const map: Record<Verb, { title: string; body: string; keyword: string }> = {
      unlock: { title: t('fastboot.unlockTitle'), body: t('fastboot.unlockBody'), keyword: 'UNLOCK' },
      lock: { title: t('fastboot.lockTitle'), body: t('fastboot.lockBody'), keyword: 'LOCK' },
      flashBoot: { title: t('fastboot.flashBootTitle'), body: t('fastboot.flashBootBody', { path }), keyword: 'FLASH' },
      bootImg: { title: t('fastboot.bootImgTitle'), body: t('fastboot.bootImgBody', { path }), keyword: '' },
      factory: { title: t('fastboot.factoryTitle'), body: t('fastboot.factoryBody', { path }), keyword: 'FLASH' },
      sideload: { title: t('fastboot.sideloadTitle'), body: t('fastboot.sideloadBody', { path }), keyword: 'SIDELOAD' },
    };
    const m = map[verb];
    setConfirmText('');
    setPending({ verb, title: m.title, body: m.body, keyword: m.keyword, path });
  };

  // Proceed from the dialog: dry-run previews; real run needs the typed keyword.
  const proceed = useCallback(async () => {
    if (!pending) return;
    const args = argsFor(pending.verb, pending.path ?? '');
    const preview = `${pending.verb === 'sideload' ? 'adb' : 'fastboot'} ${args.join(' ')}`.trim();
    if (dryRun) {
      append(`[dry-run] ${preview}`);
      setPending(null);
      return;
    }
    const needKeyword = pending.keyword.length > 0;
    if (needKeyword && confirmText.trim() !== pending.keyword) {
      append(t('fastboot.mismatch', { keyword: pending.keyword }));
      return;
    }
    setPending(null);
    setBusy(true);
    try {
      const r = await run(args);
      append(`✓ ${r.out}`);
      if (pending.verb === 'unlock' || pending.verb === 'lock') void refresh();
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, dryRun, confirmText, run, append, refresh, t]);

  const selected = devices.find((d) => d.serial === serial) ?? null;

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('fastboot.blurb')}
      </p>

      <pre className="cmd-out error" style={{ marginTop: 0 }}>
        ⚠ {t('fastboot.dangerTitle')}
        {'\n'}
        {t('fastboot.dangerBody')}
      </pre>

      <ModuleToolbar>
        <button className="mini" disabled={busy} onClick={() => void refresh()}>
          ⟳ {t('modules.refresh')}
        </button>
        <select
          className="mod-search"
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          disabled={devices.length === 0}
        >
          {devices.length === 0 ? (
            <option value="">{t('fastboot.noDeviceOption')}</option>
          ) : (
            devices.map((d) => (
              <option key={d.serial} value={d.serial}>
                {d.serial} ({d.mode})
              </option>
            ))
          )}
        </select>
        <label className="fb-check">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          {t('fastboot.dryRun')}
        </label>
        {selected && <StatusDot ok={selected.mode.includes('fastboot')} label={selected.mode} />}
      </ModuleToolbar>

      <div className="mod-form" style={{ marginTop: 4 }}>
        <input
          className="mod-search"
          placeholder={t('fastboot.pathPlaceholder')}
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
        />
      </div>
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('fastboot.pathNote')}
      </p>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={busy} onClick={() => void status()}>
          {t('fastboot.statusBtn')}
        </button>
        <button className="mini" disabled={busy} onClick={() => requestAction('unlock', false)}>
          {t('fastboot.unlockBtn')}
        </button>
        <button className="mini" disabled={busy} onClick={() => requestAction('lock', false)}>
          {t('fastboot.lockBtn')}
        </button>
        <button className="mini" disabled={busy} onClick={() => requestAction('flashBoot', true)}>
          {t('fastboot.flashBootBtn')}
        </button>
        <button className="mini" disabled={busy} onClick={() => requestAction('bootImg', true)}>
          {t('fastboot.bootImgBtn')}
        </button>
        <button className="mini" disabled={busy} onClick={() => requestAction('factory', true)}>
          {t('fastboot.factoryBtn')}
        </button>
        <button className="mini" disabled={busy} onClick={() => requestAction('sideload', true)}>
          {t('fastboot.sideloadBtn')}
        </button>
        <button className="mini" disabled={busy} onClick={() => void reboot()}>
          {t('fastboot.rebootBtn')}
        </button>
      </div>

      {pending && (
        <div className="hosts-edit" style={{ marginTop: 8 }}>
          <p style={{ fontWeight: 600, marginTop: 0 }}>
            {dryRun ? t('fastboot.previewPrefix') : '⚠ '}
            {pending.title}
          </p>
          <p className="count-note" style={{ whiteSpace: 'pre-wrap' }}>
            {pending.body}
          </p>
          {dryRun ? (
            <p className="count-note">{t('fastboot.dryRunOnNote')}</p>
          ) : pending.keyword.length > 0 ? (
            <>
              <p className="count-note">{t('fastboot.typeToConfirm', { keyword: pending.keyword })}</p>
              <input
                className="mod-search"
                placeholder={pending.keyword}
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
              />
            </>
          ) : null}
          <div className="mod-toolbar">
            <button className="mini primary" disabled={busy} onClick={() => void proceed()}>
              {dryRun ? t('fastboot.preview') : t('fastboot.proceed')}
            </button>
            <button className="mini" onClick={() => setPending(null)}>
              {t('fastboot.cancel')}
            </button>
          </div>
        </div>
      )}

      {log && <pre className="cmd-out">{log}</pre>}
    </div>
  );
}

export function FastbootModule() {
  return (
    <div className="mod">
      <DependencyGate tool="fastboot" preferId="Google.PlatformTools" query="fastboot platform-tools">
        {(path) => <FastbootPanel exePath={path} />}
      </DependencyGate>
    </div>
  );
}
