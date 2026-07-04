import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runCommand, type CommandOutput } from '../tauri/bridge';
import { DependencyGate } from './DependencyGate';
import { ModuleTabs, type ModuleTab } from './ModuleTabs';

// Native module — Oracle VirtualBox manager wrapping the VBoxManage.exe CLI.
// Lists VMs with live state, controls power (GUI / headless / pause / resume / save /
// ACPI shutdown / power off / reset), modifies CPUs/RAM/network, manages snapshots,
// creates / clones / deletes VMs, imports / exports OVA appliances, lists disk media
// and shows host info. All parsing of VBoxManage --machinereadable output is client-side.

interface VBoxVm {
  name: string;
  uuid: string;
  state: string;
  osType: string;
  cpus: number;
  memoryMb: number;
  nic1: string;
  storage: string[];
}

interface VBoxSnapshot {
  name: string;
  uuid: string;
  depth: number;
  isCurrent: boolean;
}

interface VBoxOsType {
  id: string;
  description: string;
}

interface VBoxMedium {
  uuid: string;
  location: string;
  format: string;
  capacity: string;
  type: string; // 'hdd' | 'dvd'
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

// Parse VBoxManage --machinereadable key="value" lines into a map (keeps insertion order).
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

// Parse `list ostypes` (blank-line-separated ID:/Description: blocks).
function parseOsTypes(text: string): VBoxOsType[] {
  const list: VBoxOsType[] = [];
  let id = '';
  let desc = '';
  for (const raw of (text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (/^ID:/i.test(line)) {
      id = line.slice(3).trim();
    } else if (/^Description:/i.test(line)) {
      desc = line.slice('Description:'.length).trim();
      if (id.length > 0) {
        list.push({ id, description: desc });
        id = '';
        desc = '';
      }
    }
  }
  return list;
}

// Parse `list hdds` / `list dvds` (blank-line-separated key: value blocks).
function parseMedia(text: string, kind: string): VBoxMedium[] {
  const list: VBoxMedium[] = [];
  let cur: VBoxMedium | null = null;
  const flush = () => {
    if (cur && (cur.uuid.length > 0 || cur.location.length > 0)) list.push(cur);
    cur = null;
  };
  for (const raw of (text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const val = line.slice(colon + 1).trim();
    if (key === 'uuid') {
      flush();
      cur = { uuid: val, location: '', format: '', capacity: '', type: kind };
    } else if (cur) {
      if (key === 'location') cur.location = val;
      else if (key === 'format') cur.format = val;
      else if (key === 'capacity') cur.capacity = val;
    }
  }
  flush();
  return list;
}

export function VirtualBoxModule() {
  const { t } = useTranslation();

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>
        {t('vbox.blurb')}
      </p>
      <DependencyGate tool="VBoxManage" preferId="Oracle.VirtualBox" query="virtualbox">
        {(vbox) => <VBoxManager vbox={vbox} />}
      </DependencyGate>
    </div>
  );
}

function VBoxManager({ vbox }: { vbox: string }) {
  const { t } = useTranslation();
  const [version, setVersion] = useState('');

  const run = async (args: string[]): Promise<CommandOutput> => {
    try {
      return await runCommand(vbox, args);
    } catch (e) {
      return { stdout: '', stderr: String(e instanceof Error ? e.message : e), code: -1, success: false };
    }
  };

  useEffect(() => {
    let alive = true;
    run(['--version']).then((r) => {
      if (alive) setVersion(r.stdout.trim());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vbox]);

  const tabs: ModuleTab[] = [
    {
      id: 'machines',
      en: 'Machines',
      zh: '虛擬機',
      render: () => <MachinesTab run={run} />,
    },
    {
      id: 'media',
      en: 'Media & disks',
      zh: '媒體同磁碟',
      render: () => <MediaTab run={run} />,
    },
    {
      id: 'host',
      en: 'Host',
      zh: '主機',
      render: () => <HostTab run={run} />,
    },
  ];

  return (
    <>
      {version && (
        <p className="count-note" style={{ marginTop: 0 }}>
          {t('vbox.versionReady', { ver: version })}
        </p>
      )}
      <ModuleTabs tabs={tabs} initial="machines" />
    </>
  );
}

type Run = (args: string[]) => Promise<CommandOutput>;

// ── Machines tab: list, power, modify, snapshots, create, clone, delete, export, import ──
function MachinesTab({ run }: { run: Run }) {
  const { t } = useTranslation();
  const [vms, setVms] = useState<VBoxVm[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedUuid, setSelectedUuid] = useState<string>('');
  const [snapshots, setSnapshots] = useState<VBoxSnapshot[]>([]);
  const [selectedSnap, setSelectedSnap] = useState<string>('');
  const [cpuVal, setCpuVal] = useState(2);
  const [ramVal, setRamVal] = useState(2048);
  const [nicVal, setNicVal] = useState('nat');
  const [snapName, setSnapName] = useState('');
  const [snapDesc, setSnapDesc] = useState('');
  const [out, setOut] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  // create wizard state
  const [showCreate, setShowCreate] = useState(false);
  const [osTypes, setOsTypes] = useState<VBoxOsType[]>([]);
  const [cName, setCName] = useState('New VM');
  const [cOs, setCOs] = useState('Other');
  const [cCpu, setCCpu] = useState(2);
  const [cRam, setCRam] = useState(2048);
  const [cDisk, setCDisk] = useState(25600);

  // clone state
  const [showClone, setShowClone] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [cloneLinked, setCloneLinked] = useState(false);

  // export / import state
  const [exportPath, setExportPath] = useState('');
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [importName, setImportName] = useState('');
  const [importPreview, setImportPreview] = useState('');

  const selected = vms.find((v) => v.uuid === selectedUuid) ?? null;
  const idOf = (): string => (selected ? (selected.uuid.length > 0 ? selected.uuid : selected.name) : '');
  const s = selected?.state.toLowerCase() ?? '';

  const refresh = async () => {
    setBusy('list');
    setErr('');
    try {
      const listed = await run(['list', 'vms']);
      const running = await run(['list', 'runningvms']);
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
          nic1: '',
          storage: [],
        };
        const id = uuid.length > 0 ? uuid : name;
        const info = await run(['showvminfo', id, '--machinereadable']);
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
        const nic = map.get('nic1');
        if (nic && nic.length > 0) vm.nic1 = nic;
        // storage attachments: keys look like "SATA-0-0"="/path/disk.vdi"
        for (const [k, v] of map) {
          if (/^[A-Za-z].*-\d+-\d+$/.test(k) && v && v !== 'none' && v.includes('.')) vm.storage.push(`${k}: ${v}`);
        }
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

  const select = async (vm: VBoxVm) => {
    setSelectedUuid(vm.uuid);
    setSelectedSnap('');
    if (vm.cpus > 0) setCpuVal(vm.cpus);
    if (vm.memoryMb > 0) setRamVal(vm.memoryMb);
    if (vm.nic1) setNicVal(vm.nic1);
    await refreshSnapshots(vm.uuid, vm.name);
  };

  const refreshSnapshots = async (uuid: string, name: string) => {
    const idArg = uuid.length > 0 ? uuid : name;
    if (idArg.length === 0) {
      setSnapshots([]);
      return;
    }
    const res = await run(['snapshot', idArg, 'list', '--machinereadable']);
    setSnapshots(res.success ? parseSnapshots(res.stdout) : []);
  };

  // Run a state-changing command, report, then refresh.
  const power = async (label: string, args: string[], confirmKey?: string) => {
    if (!selected) return;
    if (confirmKey && typeof window !== 'undefined' && !window.confirm(t(confirmKey))) return;
    setBusy(label);
    setErr('');
    setOut(`> VBoxManage ${args.join(' ')}\n`);
    const res = await run(args);
    if (res.success) setOut(res.stdout.trim() || t('vbox.done'));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    await refresh();
  };

  const applyModify = async () => {
    if (!selected || !isOff(selected.state)) return;
    const cpus = Math.max(1, Math.round(cpuVal));
    const mem = Math.max(4, Math.round(ramVal));
    await power('modify', ['modifyvm', idOf(), '--cpus', String(cpus), '--memory', String(mem), '--nic1', nicVal]);
  };

  const takeSnapshot = async () => {
    if (!selected) return;
    const name = snapName.trim() || `Snapshot ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const args = ['snapshot', idOf(), 'take', name];
    const desc = snapDesc.trim();
    if (desc.length > 0) args.push('--description', desc);
    setBusy('snapTake');
    setErr('');
    const res = await run(args);
    if (res.success) setOut(t('vbox.snapTaken', { name }));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    setSnapName('');
    setSnapDesc('');
    await refreshSnapshots(selectedUuid, selected.name);
  };

  const restoreSnapshot = async () => {
    if (!selected || selectedSnap.length === 0) return;
    if (!isOff(selected.state)) {
      setErr(t('vbox.restoreOffFirst'));
      return;
    }
    if (typeof window !== 'undefined' && !window.confirm(t('vbox.confirmRestore'))) return;
    setBusy('snapRestore');
    setErr('');
    const res = await run(['snapshot', idOf(), 'restore', selectedSnap]);
    if (res.success) setOut(t('vbox.snapRestored', { name: selectedSnap }));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    await refresh();
    await refreshSnapshots(selectedUuid, selected.name);
  };

  const restoreCurrent = async () => {
    if (!selected || !isOff(selected.state)) return;
    if (typeof window !== 'undefined' && !window.confirm(t('vbox.confirmRestore'))) return;
    setBusy('snapRestoreCur');
    setErr('');
    const res = await run(['snapshot', idOf(), 'restorecurrent']);
    if (res.success) setOut(t('vbox.done'));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    await refresh();
    await refreshSnapshots(selectedUuid, selected.name);
  };

  const deleteSnapshot = async () => {
    if (!selected || selectedSnap.length === 0) return;
    if (typeof window !== 'undefined' && !window.confirm(t('vbox.confirmSnapDelete'))) return;
    setBusy('snapDelete');
    setErr('');
    const res = await run(['snapshot', idOf(), 'delete', selectedSnap]);
    if (res.success) setOut(t('vbox.snapDeleted', { name: selectedSnap }));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    setSelectedSnap('');
    await refreshSnapshots(selectedUuid, selected.name);
  };

  // ── create VM ──
  const openCreate = async () => {
    setShowCreate(true);
    if (osTypes.length === 0) {
      setBusy('ostypes');
      const res = await run(['list', 'ostypes']);
      const types = parseOsTypes(res.stdout);
      setOsTypes(types);
      const def =
        types.find((o) => /ubuntu/i.test(o.id))?.id ??
        types.find((o) => /windows10/i.test(o.id))?.id ??
        types[0]?.id ??
        'Other';
      setCOs(def);
      setBusy('');
    }
  };

  const createVm = async () => {
    const name = cName.trim();
    if (name.length === 0) {
      setErr(t('vbox.needName'));
      return;
    }
    const cpus = Math.max(1, Math.round(cCpu));
    const mem = Math.max(4, Math.round(cRam));
    const disk = Math.max(0, Math.round(cDisk));
    setBusy('create');
    setErr('');
    setOut('');
    // 1) create + register
    let res = await run(['createvm', '--name', name, '--ostype', cOs || 'Other', '--register']);
    if (!res.success) {
      setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
      setBusy('');
      return;
    }
    // 2) core settings + NIC + graphics
    res = await run([
      'modifyvm', name, '--cpus', String(cpus), '--memory', String(mem),
      '--boot1', 'disk', '--boot2', 'dvd', '--nic1', 'nat', '--graphicscontroller', 'vmsvga',
    ]);
    if (!res.success) {
      setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
      setBusy('');
      await refresh();
      return;
    }
    // 3) optional disk: createmedium + storagectl + storageattach
    if (disk > 0) {
      const info = await run(['showvminfo', name, '--machinereadable']);
      const map = parseMachineReadable(info.stdout);
      const cfg = map.get('CfgFile') ?? '';
      const dir = cfg.length > 0 ? cfg.replace(/[\\/][^\\/]*$/, '') : '';
      const vdi = (dir.length > 0 ? `${dir}\\` : '') + `${name}.vdi`;
      const mk = await run(['createmedium', 'disk', '--filename', vdi, '--size', String(disk), '--format', 'VDI']);
      if (mk.success) {
        const ctl = await run(['storagectl', name, '--name', 'SATA', '--add', 'sata', '--controller', 'IntelAhci']);
        if (ctl.success) {
          await run([
            'storageattach', name, '--storagectl', 'SATA', '--port', '0', '--device', '0',
            '--type', 'hdd', '--medium', vdi,
          ]);
        }
      }
    }
    setOut(t('vbox.created', { name }));
    setBusy('');
    setShowCreate(false);
    await refresh();
  };

  // ── clone VM ──
  const openClone = () => {
    if (!selected) return;
    setCloneName(`${selected.name} Clone`);
    setCloneLinked(false);
    setShowClone(true);
  };

  const cloneVm = async () => {
    if (!selected) return;
    const name = cloneName.trim();
    if (name.length === 0) {
      setErr(t('vbox.needName'));
      return;
    }
    const args = ['clonevm', idOf(), '--name', name, '--register'];
    if (cloneLinked) args.push('--options', 'link');
    setBusy('clone');
    setErr('');
    const res = await run(args);
    if (res.success) setOut(t('vbox.cloned', { name }));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    setShowClone(false);
    await refresh();
  };

  // ── delete / unregister VM ──
  const deleteVm = async (deleteFiles: boolean) => {
    if (!selected) return;
    if (typeof window !== 'undefined' && !window.confirm(t('vbox.confirmDelete', { name: selected.name }))) return;
    const args = ['unregistervm', idOf()];
    if (deleteFiles) args.push('--delete');
    setBusy('delete');
    setErr('');
    const res = await run(args);
    if (res.success) {
      setOut(t('vbox.deleted', { name: selected.name }));
      setSelectedUuid('');
    } else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    await refresh();
  };

  // ── export OVA ──
  const exportOva = async () => {
    if (!selected) return;
    const path = exportPath.trim();
    if (path.length === 0) {
      setErr(t('vbox.needPath'));
      return;
    }
    setBusy('export');
    setErr('');
    const res = await run(['export', idOf(), '-o', path]);
    if (res.success) setOut(t('vbox.exported', { path }));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    setShowExport(false);
  };

  // ── import OVA ──
  const previewImport = async () => {
    const path = importPath.trim();
    if (path.length === 0) {
      setErr(t('vbox.needPath'));
      return;
    }
    setBusy('importPreview');
    setErr('');
    const res = await run(['import', path, '--dry-run']);
    setImportPreview(res.stdout.trim() || t('vbox.noPreview'));
    setBusy('');
  };

  const importOva = async () => {
    const path = importPath.trim();
    if (path.length === 0) {
      setErr(t('vbox.needPath'));
      return;
    }
    const args = ['import', path];
    const nm = importName.trim();
    if (nm.length > 0) args.push('--vsys', '0', '--vmname', nm);
    setBusy('import');
    setErr('');
    const res = await run(args);
    if (res.success) setOut(t('vbox.imported', { path }));
    else setErr(res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`);
    setBusy('');
    setShowImport(false);
    setImportPreview('');
    await refresh();
  };

  return (
    <>
      <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
        <button className="mini primary" disabled={busy === 'list'} onClick={refresh}>
          {busy === 'list' ? t('vbox.loading') : t('vbox.refresh')}
        </button>
        <button className="mini" disabled={!!busy} onClick={openCreate}>
          {t('vbox.newVm')}
        </button>
        <button
          className="mini"
          disabled={!!busy}
          onClick={() => {
            setShowImport(true);
            setImportPreview('');
          }}
        >
          {t('vbox.importOva')}
        </button>
      </div>

      {/* create VM wizard */}
      {showCreate && (
        <div className="panel" style={{ marginTop: 12 }}>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('vbox.createTitle')}
          </p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <input
              className="mod-search"
              placeholder={t('vbox.vmNamePh')}
              style={{ maxWidth: 220 }}
              value={cName}
              onChange={(e) => setCName(e.target.value)}
            />
            <select className="mod-select" style={{ maxWidth: 260 }} value={cOs} onChange={(e) => setCOs(e.target.value)}>
              {osTypes.length === 0 && <option value="Other">Other</option>}
              {osTypes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.description && o.description !== o.id ? `${o.description} (${o.id})` : o.id}
                </option>
              ))}
            </select>
          </div>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 6 }}>
            <label className="label">{t('vbox.cpus')}</label>
            <input className="mod-search" type="number" min={1} max={64} style={{ maxWidth: 80 }} value={cCpu} onChange={(e) => setCCpu(+e.target.value)} />
            <label className="label">{t('vbox.ram')}</label>
            <input className="mod-search" type="number" min={4} max={262144} style={{ maxWidth: 110 }} value={cRam} onChange={(e) => setCRam(+e.target.value)} />
            <label className="label">{t('vbox.diskMb')}</label>
            <input className="mod-search" type="number" min={0} max={4194304} style={{ maxWidth: 110 }} value={cDisk} onChange={(e) => setCDisk(+e.target.value)} />
          </div>
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini primary" disabled={busy === 'create'} onClick={createVm}>
              {busy === 'create' ? t('vbox.working') : t('vbox.create')}
            </button>
            <button className="mini" disabled={busy === 'create'} onClick={() => setShowCreate(false)}>
              {t('vbox.cancel')}
            </button>
          </div>
        </div>
      )}

      {/* import OVA */}
      {showImport && (
        <div className="panel" style={{ marginTop: 12 }}>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('vbox.importTitle')}
          </p>
          <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
            <input
              className="mod-search"
              placeholder={t('vbox.ovaPathPh')}
              style={{ minWidth: 280, flex: 1 }}
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
            />
            <input
              className="mod-search"
              placeholder={t('vbox.importNamePh')}
              style={{ maxWidth: 200 }}
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
            />
          </div>
          <div className="mod-toolbar" style={{ marginTop: 6 }}>
            <button className="mini" disabled={busy === 'importPreview'} onClick={previewImport}>
              {t('vbox.dryRun')}
            </button>
            <button className="mini primary" disabled={busy === 'import'} onClick={importOva}>
              {busy === 'import' ? t('vbox.working') : t('vbox.import')}
            </button>
            <button className="mini" disabled={!!busy} onClick={() => setShowImport(false)}>
              {t('vbox.cancel')}
            </button>
          </div>
          {importPreview && <pre className="cmd-out">{importPreview}</pre>}
        </div>
      )}

      {loaded && vms.length === 0 && <p className="count-note">{t('vbox.empty')}</p>}

      {vms.length > 0 && (
        <div className="panel" style={{ marginTop: 12 }}>
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
                  onClick={() => select(vm)}
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
            {selected.storage.length > 0 && (
              <div className="kv-row">
                <span className="label">{t('vbox.storage')}</span>
                <span className="value">{selected.storage.join(' · ')}</span>
              </div>
            )}
          </div>

          <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            <button className="mini primary" disabled={!!busy || !isOff(selected.state)} onClick={() => power('startGui', ['startvm', idOf(), '--type', 'gui'])}>
              {t('vbox.startGui')}
            </button>
            <button className="mini" disabled={!!busy || !isOff(selected.state)} onClick={() => power('startHeadless', ['startvm', idOf(), '--type', 'headless'])}>
              {t('vbox.startHeadless')}
            </button>
            <button className="mini" disabled={!!busy || s !== 'running'} onClick={() => power('pause', ['controlvm', idOf(), 'pause'])}>
              {t('vbox.pause')}
            </button>
            <button className="mini" disabled={!!busy || s !== 'paused'} onClick={() => power('resume', ['controlvm', idOf(), 'resume'])}>
              {t('vbox.resume')}
            </button>
            <button className="mini" disabled={!!busy || isOff(selected.state)} onClick={() => power('save', ['controlvm', idOf(), 'savestate'])}>
              {t('vbox.saveState')}
            </button>
            <button className="mini" disabled={!!busy || isOff(selected.state)} onClick={() => power('acpi', ['controlvm', idOf(), 'acpipowerbutton'])}>
              {t('vbox.acpi')}
            </button>
            <button className="mini" disabled={!!busy || isOff(selected.state)} onClick={() => power('poweroff', ['controlvm', idOf(), 'poweroff'], 'vbox.confirmPowerOff')}>
              {t('vbox.powerOff')}
            </button>
            <button className="mini" disabled={!!busy || isOff(selected.state)} onClick={() => power('reset', ['controlvm', idOf(), 'reset'], 'vbox.confirmReset')}>
              {t('vbox.reset')}
            </button>
          </div>

          {/* lifecycle: clone / export / delete */}
          <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
            <button className="mini" disabled={!!busy} onClick={openClone}>
              {t('vbox.clone')}
            </button>
            <button
              className="mini"
              disabled={!!busy}
              onClick={() => {
                setExportPath(`${selected.name}.ova`);
                setShowExport(true);
              }}
            >
              {t('vbox.exportOva')}
            </button>
            <button className="mini" disabled={!!busy} onClick={() => deleteVm(false)}>
              {t('vbox.unregister')}
            </button>
            <button className="mini" disabled={!!busy} onClick={() => deleteVm(true)} style={{ color: 'var(--danger)' }}>
              {t('vbox.deleteFiles')}
            </button>
          </div>

          {/* clone wizard */}
          {showClone && (
            <div className="dt-wrap" style={{ marginTop: 12 }}>
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('vbox.cloneTitle')}
              </p>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <input className="mod-search" placeholder={t('vbox.cloneNamePh')} style={{ maxWidth: 220 }} value={cloneName} onChange={(e) => setCloneName(e.target.value)} />
                <label className="label">
                  <input type="checkbox" checked={cloneLinked} onChange={(e) => setCloneLinked(e.target.checked)} /> {t('vbox.linkedClone')}
                </label>
                <button className="mini primary" disabled={busy === 'clone'} onClick={cloneVm}>
                  {busy === 'clone' ? t('vbox.working') : t('vbox.clone')}
                </button>
                <button className="mini" disabled={busy === 'clone'} onClick={() => setShowClone(false)}>
                  {t('vbox.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* export path */}
          {showExport && (
            <div className="dt-wrap" style={{ marginTop: 12 }}>
              <p className="count-note" style={{ marginTop: 0 }}>
                {t('vbox.exportTitle')}
              </p>
              <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
                <input className="mod-search" placeholder={t('vbox.ovaPathPh')} style={{ minWidth: 280, flex: 1 }} value={exportPath} onChange={(e) => setExportPath(e.target.value)} />
                <button className="mini primary" disabled={busy === 'export'} onClick={exportOva}>
                  {busy === 'export' ? t('vbox.working') : t('vbox.export')}
                </button>
                <button className="mini" disabled={busy === 'export'} onClick={() => setShowExport(false)}>
                  {t('vbox.cancel')}
                </button>
              </div>
            </div>
          )}

          {/* modify CPU / RAM / network */}
          <div className="dt-wrap" style={{ marginTop: 12 }}>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('vbox.modifyTitle')}
            </p>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <label className="label">{t('vbox.cpus')}</label>
              <input className="mod-search" type="number" min={1} max={64} style={{ maxWidth: 80 }} value={cpuVal} disabled={!isOff(selected.state)} onChange={(e) => setCpuVal(+e.target.value)} />
              <label className="label">{t('vbox.ram')}</label>
              <input className="mod-search" type="number" min={4} max={262144} style={{ maxWidth: 110 }} value={ramVal} disabled={!isOff(selected.state)} onChange={(e) => setRamVal(+e.target.value)} />
              <label className="label">{t('vbox.network')}</label>
              <select className="mod-select" style={{ maxWidth: 130 }} value={nicVal} disabled={!isOff(selected.state)} onChange={(e) => setNicVal(e.target.value)}>
                <option value="nat">NAT</option>
                <option value="bridged">Bridged</option>
                <option value="hostonly">Host-only</option>
                <option value="intnet">Internal</option>
                <option value="none">None</option>
              </select>
              <button className="mini primary" disabled={!!busy || !isOff(selected.state)} onClick={applyModify}>
                {t('vbox.apply')}
              </button>
            </div>
            {!isOff(selected.state) && (
              <p className="count-note" style={{ color: 'var(--danger)' }}>
                {t('vbox.modifyOffFirst')}
              </p>
            )}
          </div>

          {/* snapshots */}
          <div className="dt-wrap" style={{ marginTop: 12 }}>
            <p className="count-note" style={{ marginTop: 0 }}>
              {t('vbox.snapshots')}
            </p>
            <div className="mod-toolbar" style={{ flexWrap: 'wrap' }}>
              <input className="mod-search" placeholder={t('vbox.snapNamePh')} style={{ maxWidth: 200 }} value={snapName} onChange={(e) => setSnapName(e.target.value)} />
              <input className="mod-search" placeholder={t('vbox.snapDescPh')} style={{ maxWidth: 200 }} value={snapDesc} onChange={(e) => setSnapDesc(e.target.value)} />
              <button className="mini primary" disabled={!!busy} onClick={takeSnapshot}>
                {t('vbox.snapTake')}
              </button>
              <button className="mini" disabled={!!busy || selectedSnap.length === 0 || !isOff(selected.state)} onClick={restoreSnapshot}>
                {t('vbox.snapRestore')}
              </button>
              <button className="mini" disabled={!!busy || !isOff(selected.state)} onClick={restoreCurrent}>
                {t('vbox.snapRestoreCurrent')}
              </button>
              <button className="mini" disabled={!!busy || selectedSnap.length === 0} onClick={deleteSnapshot}>
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
                {snapshots.map((snap) => (
                  <option key={(snap.uuid || snap.name) + snap.depth} value={snap.uuid.length > 0 ? snap.uuid : snap.name}>
                    {`${'  '.repeat(snap.depth)}${snap.isCurrent ? '● ' : '○ '}${snap.name}`}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      )}

      {err && <pre className="cmd-out error">{err}</pre>}
      {out && !err && <pre className="cmd-out">{out}</pre>}
    </>
  );
}

// ── Media & disks tab: list hdds / dvds ──
function MediaTab({ run }: { run: Run }) {
  const { t } = useTranslation();
  const [media, setMedia] = useState<VBoxMedium[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    setBusy(true);
    setErr('');
    try {
      const hdds = await run(['list', 'hdds']);
      const dvds = await run(['list', 'dvds']);
      const list = [...parseMedia(hdds.stdout, 'hdd'), ...parseMedia(dvds.stdout, 'dvd')];
      setMedia(list);
      setLoaded(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mod-toolbar">
        <button className="mini primary" disabled={busy} onClick={load}>
          {busy ? t('vbox.loading') : t('vbox.loadMedia')}
        </button>
      </div>
      {err && <pre className="cmd-out error">{err}</pre>}
      {loaded && media.length === 0 && <p className="count-note">{t('vbox.noMedia')}</p>}
      {media.length > 0 && (
        <div className="panel" style={{ marginTop: 12 }}>
          <table className="dt">
            <thead>
              <tr>
                <th>{t('vbox.mediaType')}</th>
                <th>{t('vbox.mediaLocation')}</th>
                <th>{t('vbox.mediaFormat')}</th>
                <th>{t('vbox.mediaCapacity')}</th>
              </tr>
            </thead>
            <tbody>
              {media.map((m) => (
                <tr key={m.uuid || m.location}>
                  <td>{m.type.toUpperCase()}</td>
                  <td style={{ wordBreak: 'break-all' }}>{m.location || '—'}</td>
                  <td>{m.format || '—'}</td>
                  <td>{m.capacity || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="count-note" style={{ marginTop: 8 }}>
            {t('vbox.mediaCount', { n: media.length })}
          </p>
        </div>
      )}
    </>
  );
}

// ── Host info tab ──
function HostTab({ run }: { run: Run }) {
  const { t } = useTranslation();
  const [hostInfo, setHostInfo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    const res = await run(['list', 'hostinfo']);
    setHostInfo(res.stdout.trim() || t('vbox.noHostInfo'));
    setBusy(false);
  };

  return (
    <>
      <div className="mod-toolbar">
        <button className="mini primary" disabled={busy} onClick={load}>
          {busy ? t('vbox.loading') : t('vbox.loadHost')}
        </button>
      </div>
      {hostInfo && (
        <div className="panel" style={{ marginTop: 12 }}>
          <p className="count-note" style={{ marginTop: 0 }}>
            {t('vbox.hostInfo')}
          </p>
          <pre className="cmd-out">{hostInfo}</pre>
        </div>
      )}
    </>
  );
}
