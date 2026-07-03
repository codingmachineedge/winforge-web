import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';

// Native module — Oracle VirtualBox manager wrapping the VBoxManage.exe CLI.
// Lists VMs with live state, controls power (GUI / headless / pause / resume / save /
// ACPI shutdown / power off / reset), modifies CPUs & RAM, manages snapshots, and shows
// host info. All parsing of VBoxManage --machinereadable output happens client-side.

interface VBoxVm {
  name: string;
  uuid: string;
  state: string;
  osType: string;
  cpus: number;
  memoryMb: number;
}

interface VBoxSnapshot {
  name: string;
  uuid: string;
  depth: number;
  isCurrent: boolean;
}

const stateEn: Record<string, string> = {
  running: 'Running',
  paused: 'Paused',
  saved: 'Saved',
  poweroff: 'Powered off',
  aborted: 'Aborted',
  stuck: 'Stuck',
  starting: 'Starting',
  stopping: 'Stopping',
};

function isOff(state: string): boolean {
  const s = state.toLowerCase();
  return s !== 'running' && s !== 'paused';
}

// Parse `"VM name" {uuid}` lines from `list vms` / `list runningvms`.
function parseNameUuid(text: string): { name: string; uuid: string }[] {
  const out: { name: string; uuid: string }[] = [];
  for (const raw of (text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const brace = line.lastIndexOf('{');
    if (brace >= 0) {
      const name = line.slice(0, brace).trim().replace(/^"|"$/g, '');
      const uuid = line.slice(brace).trim().replace(/^\{/, '').replace(/\}$/, '');
      if (name.length > 0) out.push({ name, uuid });
    } else {
      const name = line.replace(/^"|"$/g, '');
      if (name.length > 0) out.push({ name, uuid: '' });
    }
  }
  return out;
}

// Parse VBoxManage --machinereadable key="value" lines into a map.
function parseMachineReadable(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of (text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    map.set(key, val);
  }
  return map;
}

function parseSnapshots(text: string): VBoxSnapshot[] {
  const list: VBoxSnapshot[] = [];
  const map = parseMachineReadable(text);
  const currentUuid = map.get('CurrentSnapshotUUID') ?? '';
  for (const [key, value] of map) {
    if (!key.startsWith('SnapshotName')) continue;
    const suffix = key.slice('SnapshotName'.length); // "" or "-1-2-3"
    const depth = suffix.length === 0 ? 0 : suffix.split('-').filter((s) => s.length > 0).length;
    const uuid = map.get('SnapshotUUID' + suffix) ?? '';
    list.push({
      name: value,
      uuid,
      depth,
      isCurrent: uuid.length > 0 && uuid.toLowerCase() === currentUuid.toLowerCase(),
    });
  }
  return list;
}

export function VirtualBoxModule() {
  const { t } = useTranslation();
  const [vms, setVms] = useState<VBoxVm[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedUuid, setSelectedUuid] = useState<string>('');
  const [snapshots, setSnapshots] = useState<VBoxSnapshot[]>([]);
  const [selectedSnap, setSelectedSnap] = useState<string>('');
  const [cpuVal, setCpuVal] = useState(2);
  const [ramVal, setRamVal] = useState(2048);
  const [snapName, setSnapName] = useState('');
  const [hostInfo, setHostInfo] = useState('');
  const [out, setOut] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const selected = vms.find((v) => v.uuid === selectedUuid) ?? null;

  const run = async (vbox: string, args: string[]): Promise<CommandOutput> => {
    try {
      return await runCommand(vbox, args);
    } catch (e) {
      return { stdout: '', stderr: String(e instanceof Error ? e.message : e), code: -1, success: false };
    }
  };

  const refresh = async (vbox: string) => {
    setBusy('list');
    setErr('');
    try {
      const listed = await run(vbox, ['list', 'vms']);
      const running = await run(vbox, ['list', 'runningvms']);
      const runningSet = new Set(parseNameUuid(running.stdout).map((r) => r.uuid.toLowerCase()));
      const rows: VBoxVm[] = [];
      for (const { name, uuid } of parseNameUuid(listed.stdout)) {
        const vm: VBoxVm = {
          name,
          uuid,
          state: runningSet.has(uuid.toLowerCase()) ? 'running' : 'poweroff',
          osType: '',
          cpus: 0,
          memoryMb: 0,
        };
        const id = uuid.length > 0 ? uuid : name;
        const info = await run(vbox, ['showvminfo', id, '--machinereadable']);
        const map = parseMachineReadable(info.stdout);
        const st = map.get('VMState');
        if (st && st.length > 0) vm.state = st;
        const c = map.get('cpus');
        if (c) {
          const n = parseInt(c, 10);
          if (!Number.isNaN(n)) vm.cpus = n;
        }
        const m = map.get('memory');
        if (m) {
          const n = parseInt(m, 10);
          if (!Number.isNaN(n)) vm.memoryMb = n;
        }
        const os = map.get('ostype');
        if (os && os.length > 0) vm.osType = os;
        const nm = map.get('name');
        if (nm && nm.length > 0) vm.name = nm;
        rows.push(vm);
      }
      rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      setVms(rows);
      setLoaded(true);
      if (selectedUuid && !rows.some((v) => v.uuid === selectedUuid)) {
        setSelectedUuid('');
        setSnapshots([]);
      }
    } finally {
      setBusy('');
    }
  };

  const select = async (vbox: string, vm: VBoxVm) => {
    setSelectedUuid(vm.uuid);
    setSelectedSnap('');
    if (vm.cpus > 0) setCpuVal(vm.cpus);
    if (vm.memoryMb > 0) setRamVal(vm.memoryMb);
    await refreshSnapshots(vbox, vm.uuid);
  };

  const refreshSnapshots = async (vbox: string, id: string) => {
    const idArg = id.length > 0 ? id : selected?.name ?? '';
    if (idArg.length === 0) {
      setSnapshots([]);
      return;
    }
    const res = await run(vbox, ['snapshot', idArg, 'list', '--machinereadable']);
    setSnapshots(res.success ? parseSnapshots(res.stdout) : []);
  };

  // Run a state-changing command, report, then refresh.
  const power = async (vbox: string, label: string, args: string[]) => {
    if (!selected) return;
    setBusy(label);
    setErr('');
    setOut(`> VBoxManage ${args.join(' ')}\n`);
    const res = await run(vbox, args);
    if (res.success) {
      setOut(res.stdout.trim() || t('vbox.done'));
    } else {
      setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    }
    setBusy('');
    await refresh(vbox);
  };

  const idOf = (): string => (selected ? (selected.uuid.length > 0 ? selected.uuid : selected.name) : '');

  const applyModify = async (vbox: string) => {
    if (!selected || !isOff(selected.state)) return;
    const cpus = Math.max(1, Math.round(cpuVal));
    const mem = Math.max(4, Math.round(ramVal));
    await power(vbox, 'modify', ['modifyvm', idOf(), '--cpus', String(cpus), '--memory', String(mem)]);
  };

  const takeSnapshot = async (vbox: string) => {
    if (!selected) return;
    const name = snapName.trim() || `Snapshot ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    setBusy('snapTake');
    setErr('');
    const res = await run(vbox, ['snapshot', idOf(), 'take', name]);
    if (res.success) setOut(t('vbox.snapTaken', { name }));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    setSnapName('');
    await refreshSnapshots(vbox, selectedUuid);
  };

  const restoreSnapshot = async (vbox: string) => {
    if (!selected || selectedSnap.length === 0) return;
    if (!isOff(selected.state)) {
      setErr(t('vbox.restoreOffFirst'));
      return;
    }
    setBusy('snapRestore');
    setErr('');
    const res = await run(vbox, ['snapshot', idOf(), 'restore', selectedSnap]);
    if (res.success) setOut(t('vbox.snapRestored', { name: selectedSnap }));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    await refresh(vbox);
    await refreshSnapshots(vbox, selectedUuid);
  };

  const deleteSnapshot = async (vbox: string) => {
    if (!selected || selectedSnap.length === 0) return;
    setBusy('snapDelete');
    setErr('');
    const res = await run(vbox, ['snapshot', idOf(), 'delete', selectedSnap]);
    if (res.success) setOut(t('vbox.snapDeleted', { name: selectedSnap }));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    setSelectedSnap('');
    await refreshSnapshots(vbox, selectedUuid);
  };

  const loadHost = async (vbox: string) => {
    setBusy('host');
    setErr('');
    const res = await run(vbox, ['list', 'hostinfo']);
    setHostInfo(res.stdout.trim() || t('vbox.noHostInfo'));
    setBusy('');
  };

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('vbox.blurb')}
      </p>
      <DependencyGate tool="VBoxManage" preferId="Oracle.VirtualBox" query="virtualbox">
        {(vbox) => (
          <>
            <div className="mod-toolbar">
              <button className="mini primary" disabled={busy === 'list'} onClick={() => refresh(vbox)}>
                {busy === 'list' ? t('vbox.loading') : t('vbox.refresh')}
              </button>
              <button className="mini" disabled={!!busy} onClick={() => loadHost(vbox)}>
                {t('vbox.loadHost')}
              </button>
            </div>

            {loaded && vms.length === 0 && <p className="count-note">{t('vbox.empty')}</p>}

            {vms.length > 0 && (
              <div className="panel">
                <table className="dt">
                  <thead>
                    <tr>
                      <th>{t('vbox.colName')}</th>
                      <th>{t('vbox.colState')}</th>
                      <th style={{ textAlign: 'right' }}>{t('vbox.colCpu')}</th>
                      <th style={{ textAlign: 'right' }}>{t('vbox.colRam')}</th>
                      <th>{t('vbox.colOs')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vms.map((vm) => (
                      <tr
                        key={vm.uuid || vm.name}
                        onClick={() => select(vbox, vm)}
                        style={{
                          cursor: 'pointer',
                          background: vm.uuid === selectedUuid ? 'var(--sel, rgba(127,127,127,0.15))' : undefined,
                        }}
                      >
                        <td>{vm.name}</td>
                        <td>{stateEn[vm.state.toLowerCase()] ?? vm.state}</td>
                        <td style={{ textAlign: 'right' }}>{vm.cpus || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{vm.memoryMb ? `${vm.memoryMb} MB` : '—'}</td>
                        <td>{vm.osType || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="count-note" style={{ marginTop: 8 }}>
                  {t('vbox.count', { n: vms.length })}
                </p>
              </div>
            )}

            {selected && (
              <div className="panel" style={{ marginTop: 12 }}>
                <div className="kv-list">
                  <div className="kv-row">
                    <span className="label">{t('vbox.selected')}</span>
                    <span className="value">{selected.name}</span>
                  </div>
                  <div className="kv-row">
                    <span className="label">{t('vbox.colState')}</span>
                    <span className="value">{stateEn[selected.state.toLowerCase()] ?? selected.state}</span>
                  </div>
                </div>

                <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  <button
                    className="mini primary"
                    disabled={!!busy || !isOff(selected.state)}
                    onClick={() => power(vbox, 'startGui', ['startvm', idOf(), '--type', 'gui'])}
                  >
                    {t('vbox.startGui')}
                  </button>
                  <button
                    className="mini"
                    disabled={!!busy || !isOff(selected.state)}
                    onClick={() => power(vbox, 'startHeadless', ['startvm', idOf(), '--type', 'headless'])}
                  >
                    {t('vbox.startHeadless')}
                  </button>
                  <button
                    className="mini"
                    disabled={!!busy || selected.state.toLowerCase() !== 'running'}
                    onClick={() => power(vbox, 'pause', ['controlvm', idOf(), 'pause'])}
                  >
                    {t('vbox.pause')}
                  </button>
                  <button
                    className="mini"
                    disabled={!!busy || selected.state.toLowerCase() !== 'paused'}
                    onClick={() => power(vbox, 'resume', ['controlvm', idOf(), 'resume'])}
                  >
                    {t('vbox.resume')}
                  </button>
                  <button
                    className="mini"
                    disabled={!!busy || isOff(selected.state)}
                    onClick={() => power(vbox, 'save', ['controlvm', idOf(), 'savestate'])}
                  >
                    {t('vbox.saveState')}
                  </button>
                  <button
                    className="mini"
                    disabled={!!busy || isOff(selected.state)}
                    onClick={() => power(vbox, 'acpi', ['controlvm', idOf(), 'acpipowerbutton'])}
                  >
                    {t('vbox.acpi')}
                  </button>
                  <button
                    className="mini"
                    disabled={!!busy || isOff(selected.state)}
                    onClick={() => power(vbox, 'poweroff', ['controlvm', idOf(), 'poweroff'])}
                  >
                    {t('vbox.powerOff')}
                  </button>
                  <button
                    className="mini"
                    disabled={!!busy || isOff(selected.state)}
                    onClick={() => power(vbox, 'reset', ['controlvm', idOf(), 'reset'])}
                  >
                    {t('vbox.reset')}
                  </button>
                </div>

                <div className="dt-wrap" style={{ marginTop: 12 }}>
                  <p className="count-note" style={{ marginTop: 0 }}>
                    {t('vbox.modifyTitle')}
                  </p>
                  <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                    <label className="label">{t('vbox.cpus')}</label>
                    <input
                      className="mod-search"
                      type="number"
                      min={1}
                      max={64}
                      style={{ maxWidth: 80 }}
                      value={cpuVal}
                      disabled={!isOff(selected.state)}
                      onChange={(e) => setCpuVal(+e.target.value)}
                    />
                    <label className="label">{t('vbox.ram')}</label>
                    <input
                      className="mod-search"
                      type="number"
                      min={4}
                      max={262144}
                      style={{ maxWidth: 110 }}
                      value={ramVal}
                      disabled={!isOff(selected.state)}
                      onChange={(e) => setRamVal(+e.target.value)}
                    />
                    <button
                      className="mini primary"
                      disabled={!!busy || !isOff(selected.state)}
                      onClick={() => applyModify(vbox)}
                    >
                      {t('vbox.apply')}
                    </button>
                  </div>
                  {!isOff(selected.state) && (
                    <p className="count-note" style={{ color: 'var(--danger)' }}>
                      {t('vbox.modifyOffFirst')}
                    </p>
                  )}
                </div>

                <div className="dt-wrap" style={{ marginTop: 12 }}>
                  <p className="count-note" style={{ marginTop: 0 }}>
                    {t('vbox.snapshots')}
                  </p>
                  <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                    <input
                      className="mod-search"
                      placeholder={t('vbox.snapNamePh')}
                      style={{ maxWidth: 220 }}
                      value={snapName}
                      onChange={(e) => setSnapName(e.target.value)}
                    />
                    <button className="mini primary" disabled={!!busy} onClick={() => takeSnapshot(vbox)}>
                      {t('vbox.snapTake')}
                    </button>
                    <button
                      className="mini"
                      disabled={!!busy || selectedSnap.length === 0 || !isOff(selected.state)}
                      onClick={() => restoreSnapshot(vbox)}
                    >
                      {t('vbox.snapRestore')}
                    </button>
                    <button
                      className="mini"
                      disabled={!!busy || selectedSnap.length === 0}
                      onClick={() => deleteSnapshot(vbox)}
                    >
                      {t('vbox.snapDelete')}
                    </button>
                  </div>
                  {snapshots.length === 0 ? (
                    <p className="count-note">{t('vbox.noSnapshots')}</p>
                  ) : (
                    <select
                      className="mod-select"
                      size={Math.min(6, Math.max(2, snapshots.length))}
                      style={{ width: '100%', marginTop: 8 }}
                      value={selectedSnap}
                      onChange={(e) => setSelectedSnap(e.target.value)}
                    >
                      {snapshots.map((s) => (
                        <option key={(s.uuid || s.name) + s.depth} value={s.uuid.length > 0 ? s.uuid : s.name}>
                          {`${'  '.repeat(s.depth)}${s.isCurrent ? '● ' : '○ '}${s.name}`}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            )}

            {err && <pre className="cmd-out error">{err}</pre>}
            {out && !err && <pre className="cmd-out">{out}</pre>}

            {hostInfo && (
              <div className="panel" style={{ marginTop: 12 }}>
                <p className="count-note" style={{ marginTop: 0 }}>
                  {t('vbox.hostInfo')}
                </p>
                <pre className="cmd-out">{hostInfo}</pre>
              </div>
            )}
          </>
        )}
      </DependencyGate>
    </div>
  );
}
