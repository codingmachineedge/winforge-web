import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runPowershell, runPowershellJson } from '../tauri/bridge';
import { AsyncState, ModuleToolbar, StatusDot, useAsync } from './common';

// --------------------------------------------------------------------------
// Live Core Audio (WASAPI) bridge.
//
// The desktop C# module (WinForge.Services.AudioMixer) drives Core Audio via
// raw COM interop with no third-party libraries. We port the same interop into
// an inline C# type that PowerShell compiles with Add-Type, so this native web
// module talks to the exact same live endpoints: render-device enumeration,
// per-device master volume/mute, per-app sessions, per-app volume/mute, and
// IPolicyConfig default-endpoint switching. Reads emit JSON; writes echo "ok".
// --------------------------------------------------------------------------

// The interop source, shared by every script. Kept as one Add-Type block so a
// single compiled assembly serves the whole call.
const AUDIO_CS = String.raw`
using System;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace WFWeb {
  public sealed class Dev { public string Id=""; public string Name=""; public bool IsDefault; public float Level; public bool Muted; }
  public sealed class Sess { public int Pid; public string Name=""; public float Level; public bool Muted; public string SessionId=""; public bool IsSystem; }

  public static class Audio {
    static readonly Guid CLSID_Enum = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid CLSID_Policy = new Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9");
    const int eRender=0, eConsole=0, eMultimedia=1, eComm=2;
    const int STATE_ACTIVE=0x1, STGM_READ=0x0;
    static readonly Guid FN_fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
    const int FN_pid=14; const uint CLSCTX_ALL=0x17;

    public static List<Dev> Devices() {
      var list=new List<Dev>(); object eo=null; IMMDeviceEnumerator en=null; IMMDeviceCollection coll=null; IMMDevice defDev=null; string defId="";
      try {
        eo=Create(out en);
        try { if (en.GetDefaultAudioEndpoint(eRender,eConsole,out defDev)>=0 && defDev!=null) defDev.GetId(out defId); } catch {}
        Chk(en.EnumAudioEndpoints(eRender,STATE_ACTIVE,out IntPtr pc));
        coll=(IMMDeviceCollection)Marshal.GetObjectForIUnknown(pc); Marshal.Release(pc);
        Chk(coll.GetCount(out int n));
        for(int i=0;i<n;i++){ IMMDevice d=null; IAudioEndpointVolume epv=null;
          try {
            if(coll.Item(i,out d)<0||d==null) continue;
            string id=""; try{ d.GetId(out id);}catch{} if(string.IsNullOrEmpty(id)) continue;
            float lvl=0; int mute=0;
            try { epv=ActEpv(d); epv.GetMasterVolumeLevelScalar(out lvl); epv.GetMute(out mute); } catch {}
            list.Add(new Dev{ Id=id, Name=FriendlyName(d,id),
              IsDefault=!string.IsNullOrEmpty(defId)&&string.Equals(id,defId,StringComparison.OrdinalIgnoreCase),
              Level=lvl, Muted=mute!=0 });
          } finally { Rel(epv); Rel(d); }
        }
      } finally { Rel(defDev); Rel(coll); Rel(en); Rel(eo); }
      return list;
    }

    public static List<Sess> Sessions(string deviceId) {
      var list=new List<Sess>(); object eo=null; IMMDeviceEnumerator en=null; IMMDevice dev=null; object mo=null; IAudioSessionManager2 mgr=null; IAudioSessionEnumerator se=null;
      try {
        eo=Create(out en); dev=ById(en,deviceId); mo=ActMgr(dev,out mgr);
        Chk(mgr.GetSessionEnumerator(out se)); Chk(se.GetCount(out int n));
        for(int i=0;i<n;i++){ IAudioSessionControl c=null; IAudioSessionControl2 c2=null; ISimpleAudioVolume v=null;
          try {
            Chk(se.GetSession(i,out c)); if(c==null) continue;
            c2=(IAudioSessionControl2)c; v=(ISimpleAudioVolume)c;
            bool sys = c2.IsSystemSoundsSession()==0;
            int pid=0; c2.GetProcessId(out pid);
            string sid=""; try{c2.GetSessionIdentifier(out sid);}catch{}
            if(string.IsNullOrEmpty(sid)){ try{c2.GetSessionInstanceIdentifier(out sid);}catch{} }
            string name=""; try{c2.GetDisplayName(out name);}catch{} name=(name??"").Trim();
            if(sys) name="System sounds";
            else if(string.IsNullOrEmpty(name)||name.StartsWith("@",StringComparison.Ordinal)) name=PName(pid);
            if(string.IsNullOrEmpty(name)) name = pid>0 ? ("PID "+pid) : "Unknown";
            float lvl=0; int mute=0; v.GetMasterVolume(out lvl); v.GetMute(out mute);
            list.Add(new Sess{ Pid=pid, Name=name, Level=lvl, Muted=mute!=0, SessionId=sid, IsSystem=sys });
          } finally { Rel(v); Rel(c2); Rel(c); }
        }
      } finally { Rel(se); Rel(mgr); Rel(mo); Rel(dev); Rel(en); Rel(eo); }
      return list;
    }

    public static void SetMaster(string deviceId, float lvl, int hasMute, int mute) {
      object eo=null; IMMDeviceEnumerator en=null; IMMDevice dev=null; IAudioEndpointVolume epv=null;
      try { eo=Create(out en); dev=ById(en,deviceId); epv=ActEpv(dev); Guid ctx=Guid.Empty;
        if(lvl>=0) Chk(epv.SetMasterVolumeLevelScalar(Clamp(lvl),ref ctx));
        if(hasMute!=0) Chk(epv.SetMute(mute!=0?1:0,ref ctx));
      } finally { Rel(epv); Rel(dev); Rel(en); Rel(eo); }
    }

    public static void SetSession(string deviceId, string sessionId, float lvl, int hasMute, int mute) {
      object eo=null; IMMDeviceEnumerator en=null; IMMDevice dev=null; object mo=null; IAudioSessionManager2 mgr=null; IAudioSessionEnumerator se=null;
      try { eo=Create(out en); dev=ById(en,deviceId); mo=ActMgr(dev,out mgr);
        Chk(mgr.GetSessionEnumerator(out se)); Chk(se.GetCount(out int n));
        for(int i=0;i<n;i++){ IAudioSessionControl c=null; IAudioSessionControl2 c2=null; ISimpleAudioVolume v=null;
          try { Chk(se.GetSession(i,out c)); if(c==null) continue; c2=(IAudioSessionControl2)c;
            string id=""; try{c2.GetSessionIdentifier(out id);}catch{}
            string inst=""; try{c2.GetSessionInstanceIdentifier(out inst);}catch{}
            if(!string.Equals(id,sessionId,StringComparison.Ordinal)&&!string.Equals(inst,sessionId,StringComparison.Ordinal)) continue;
            v=(ISimpleAudioVolume)c; Guid ctx=Guid.Empty;
            if(lvl>=0) Chk(v.SetMasterVolume(Clamp(lvl),ref ctx));
            if(hasMute!=0) Chk(v.SetMute(mute!=0?1:0,ref ctx));
          } finally { Rel(v); Rel(c2); Rel(c); }
        }
      } finally { Rel(se); Rel(mgr); Rel(mo); Rel(dev); Rel(en); Rel(eo); }
    }

    public static void SetDefault(string deviceId) {
      if(string.IsNullOrEmpty(deviceId)) return;
      object cl=null; IPolicyConfig cfg=null;
      try { Type t=Type.GetTypeFromCLSID(CLSID_Policy,true); cl=Activator.CreateInstance(t); cfg=(IPolicyConfig)cl;
        Chk(cfg.SetDefaultEndpoint(deviceId,eConsole)); Chk(cfg.SetDefaultEndpoint(deviceId,eMultimedia)); Chk(cfg.SetDefaultEndpoint(deviceId,eComm));
      } finally { Rel(cfg); Rel(cl); }
    }

    static IMMDevice ById(IMMDeviceEnumerator en,string id){ if(string.IsNullOrEmpty(id)){ Chk(en.GetDefaultAudioEndpoint(eRender,eConsole,out IMMDevice d)); return d; } Chk(en.GetDevice(id,out IMMDevice dv)); return dv; }
    static object Create(out IMMDeviceEnumerator en){ Type t=Type.GetTypeFromCLSID(CLSID_Enum,true); object o=Activator.CreateInstance(t); en=(IMMDeviceEnumerator)o; return o; }
    static IAudioEndpointVolume ActEpv(IMMDevice d){ Guid iid=typeof(IAudioEndpointVolume).GUID; Chk(d.Activate(ref iid,CLSCTX_ALL,IntPtr.Zero,out object o)); return (IAudioEndpointVolume)o; }
    static object ActMgr(IMMDevice d,out IAudioSessionManager2 m){ Guid iid=typeof(IAudioSessionManager2).GUID; Chk(d.Activate(ref iid,CLSCTX_ALL,IntPtr.Zero,out object o)); m=(IAudioSessionManager2)o; return o; }
    static string PName(int pid){ if(pid<=0) return ""; try{ using(var p=Process.GetProcessById(pid)) return p.ProcessName; }catch{ return ""; } }
    static string FriendlyName(IMMDevice d,string fb){ IPropertyStore st=null;
      try { if(d.OpenPropertyStore(STGM_READ,out IntPtr ps)<0||ps==IntPtr.Zero) return Short(fb);
        st=(IPropertyStore)Marshal.GetObjectForIUnknown(ps); Marshal.Release(ps);
        var k=new PROPERTYKEY{ fmtid=FN_fmtid, pid=(uint)FN_pid }; var pv=new PROPVARIANT();
        try { if(st.GetValue(ref k,out pv)>=0){ string s=pv.Str(); if(!string.IsNullOrWhiteSpace(s)) return s; } }
        finally { try{ PropVariantClear(ref pv);}catch{} }
      } catch {} finally { Rel(st); } return Short(fb);
    }
    static string Short(string id){ if(string.IsNullOrEmpty(id)) return "Unknown device"; int dot=id.LastIndexOf('.'); return dot>=0&&dot<id.Length-1?id.Substring(dot+1):id; }
    static float Clamp(float v)=> v<0f?0f:(v>1f?1f:v);
    static void Chk(int hr){ if(hr<0) Marshal.ThrowExceptionForHR(hr); }
    static void Rel(object o){ if(o!=null&&Marshal.IsComObject(o)){ try{ Marshal.ReleaseComObject(o);}catch{} } }
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pvar);
  }

  [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int f,int m,out IntPtr p);
    [PreserveSig] int GetDefaultAudioEndpoint(int f,int r,[MarshalAs(UnmanagedType.Interface)] out IMMDevice d);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id,[MarshalAs(UnmanagedType.Interface)] out IMMDevice d);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr c);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr c);
  }
  [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid,uint ctx,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o);
    [PreserveSig] int OpenPropertyStore(int a,out IntPtr p);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int s);
  }
  [ComImport,Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { [PreserveSig] int GetCount(out int n); [PreserveSig] int Item(int i,[MarshalAs(UnmanagedType.Interface)] out IMMDevice d); }
  [ComImport,Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr p); [PreserveSig] int UnregisterControlChangeNotify(IntPtr p);
    [PreserveSig] int GetChannelCount(out int n);
    [PreserveSig] int SetMasterVolumeLevel(float db,ref Guid g); [PreserveSig] int SetMasterVolumeLevelScalar(float l,ref Guid g);
    [PreserveSig] int GetMasterVolumeLevel(out float db); [PreserveSig] int GetMasterVolumeLevelScalar(out float l);
    [PreserveSig] int SetChannelVolumeLevel(int c,float db,ref Guid g); [PreserveSig] int SetChannelVolumeLevelScalar(int c,float l,ref Guid g);
    [PreserveSig] int GetChannelVolumeLevel(int c,out float db); [PreserveSig] int GetChannelVolumeLevelScalar(int c,out float l);
    [PreserveSig] int SetMute(int m,ref Guid g); [PreserveSig] int GetMute(out int m);
    [PreserveSig] int GetVolumeStepInfo(out int s,out int c); [PreserveSig] int VolumeStepUp(ref Guid g); [PreserveSig] int VolumeStepDown(ref Guid g);
    [PreserveSig] int QueryHardwareSupport(out int m); [PreserveSig] int GetVolumeRange(out float mn,out float mx,out float inc);
  }
  [ComImport,Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr g,int f,out IntPtr c); [PreserveSig] int GetSimpleAudioVolume(IntPtr g,int f,out IntPtr v);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
    [PreserveSig] int RegisterSessionNotification(IntPtr n); [PreserveSig] int UnregisterSessionNotification(IntPtr n);
    [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string s,IntPtr n); [PreserveSig] int UnregisterDuckNotification(IntPtr n);
  }
  [ComImport,Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator { [PreserveSig] int GetCount(out int n); [PreserveSig] int GetSession(int i,[MarshalAs(UnmanagedType.Interface)] out IAudioSessionControl s); }
  [ComImport,Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl {
    [PreserveSig] int GetState(out int s); [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string n,ref Guid g); [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string p);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string p,ref Guid g); [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(ref Guid o,ref Guid g); [PreserveSig] int RegisterAudioSessionNotification(IntPtr n); [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
  }
  [ComImport,Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int s); [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string n,ref Guid g); [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string p);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string p,ref Guid g); [PreserveSig] int GetGroupingParam(out Guid g);
    [PreserveSig] int SetGroupingParam(ref Guid o,ref Guid g); [PreserveSig] int RegisterAudioSessionNotification(IntPtr n); [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id); [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out int pid); [PreserveSig] int IsSystemSoundsSession(); [PreserveSig] int SetDuckingPreference(int o);
  }
  [ComImport,Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume { [PreserveSig] int SetMasterVolume(float l,ref Guid g); [PreserveSig] int GetMasterVolume(out float l); [PreserveSig] int SetMute(int m,ref Guid g); [PreserveSig] int GetMute(out int m); }
  [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore { [PreserveSig] int GetCount(out uint n); [PreserveSig] int GetAt(uint i,out PROPERTYKEY k); [PreserveSig] int GetValue(ref PROPERTYKEY k,out PROPVARIANT v); [PreserveSig] int SetValue(ref PROPERTYKEY k,ref PROPVARIANT v); [PreserveSig] int Commit(); }
  [ComImport,Guid("F8679F50-850A-41CF-9C72-430F290290C8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    [PreserveSig] int GetMixFormat(IntPtr a,IntPtr b); [PreserveSig] int GetDeviceFormat(IntPtr a,int b,IntPtr c); [PreserveSig] int ResetDeviceFormat(IntPtr a);
    [PreserveSig] int SetDeviceFormat(IntPtr a,IntPtr b,IntPtr c); [PreserveSig] int GetProcessingPeriod(IntPtr a,int b,IntPtr c,IntPtr d); [PreserveSig] int SetProcessingPeriod(IntPtr a,IntPtr b);
    [PreserveSig] int GetShareMode(IntPtr a,IntPtr b); [PreserveSig] int SetShareMode(IntPtr a,IntPtr b); [PreserveSig] int GetPropertyValue(IntPtr a,IntPtr b,IntPtr c); [PreserveSig] int SetPropertyValue(IntPtr a,IntPtr b,IntPtr c);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id,int r); [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id,int v);
  }
  [StructLayout(LayoutKind.Sequential,Pack=4)] struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p;
    public string Str(){ if(p==IntPtr.Zero) return null; if(vt==31) return Marshal.PtrToStringUni(p); if(vt==8) return Marshal.PtrToStringBSTR(p); return null; }
  }
}
`;

// STA is required for these apartment-friendly COM objects to be reliable.
const PS_PREAMBLE = `Add-Type -TypeDefinition @'
${AUDIO_CS}
'@ -Language CSharp | Out-Null`;

// Escape a JS string for a single-quoted PowerShell literal.
function psq(s: string): string {
  return s.replace(/'/g, "''");
}

interface DevRow {
  Id: string;
  Name: string;
  IsDefault: boolean;
  Level: number;
  Muted: boolean;
}
interface SessRow {
  Pid: number;
  Name: string;
  Level: number;
  Muted: boolean;
  SessionId: string;
  IsSystem: boolean;
}

interface MixerData {
  devices: DevRow[];
}

async function loadDevices(): Promise<DevRow[]> {
  const rows = await runPowershellJson<DevRow>(
    `${PS_PREAMBLE}; [WFWeb.Audio]::Devices() | Select-Object Id,Name,IsDefault,Level,Muted`,
  );
  return rows;
}

async function loadSessions(deviceId: string): Promise<SessRow[]> {
  const rows = await runPowershellJson<SessRow>(
    `${PS_PREAMBLE}; [WFWeb.Audio]::Sessions('${psq(deviceId)}') | Select-Object Pid,Name,Level,Muted,SessionId,IsSystem`,
  );
  return rows;
}

async function apply(script: string): Promise<void> {
  const res = await runPowershell(`${PS_PREAMBLE}; ${script}; 'ok'`);
  if (!res.success) throw new Error(res.stderr.trim() || `exit ${res.code}`);
}

const pct = (level: number) => Math.max(0, Math.min(100, Math.round(level * 100)));

export function VolumeMixerModule() {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string>('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Device list drives the picker + master card.
  const devState = useAsync<MixerData>(async () => ({ devices: await loadDevices() }), []);
  const devices = useMemo(() => devState.data?.devices ?? [], [devState.data]);

  // The effective device: explicit selection, else the default endpoint, else first.
  const activeDevice = useMemo<DevRow | undefined>(() => {
    if (selectedId) return devices.find((d) => d.Id === selectedId);
    return devices.find((d) => d.IsDefault) ?? devices[0];
  }, [devices, selectedId]);

  const activeId = activeDevice?.Id ?? '';

  // Sessions on the active device; reloads whenever the device changes or we refresh.
  const sessState = useAsync<SessRow[]>(
    () => (devices.length ? loadSessions(activeId) : Promise.resolve([])),
    [activeId, devices.length],
  );
  const sessions = sessState.data ?? [];

  const reloadAll = useCallback(() => {
    devState.reload();
    sessState.reload();
  }, [devState, sessState]);

  const guard = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setMsg(`${t('mixer.actionFailed')}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const setMasterLevel = (level: number) =>
    guard(
      () => apply(`[WFWeb.Audio]::SetMaster('${psq(activeId)}', ${level.toFixed(4)}, 0, 0)`),
      t('mixer.applied'),
    ).then(() => devState.reload());

  const toggleMasterMute = (muted: boolean) =>
    guard(
      () => apply(`[WFWeb.Audio]::SetMaster('${psq(activeId)}', -1, 1, ${muted ? 1 : 0})`),
      muted ? t('mixer.muted') : t('mixer.unmuted'),
    ).then(() => devState.reload());

  const setSessionLevel = (s: SessRow, level: number) =>
    guard(
      () =>
        apply(
          `[WFWeb.Audio]::SetSession('${psq(activeId)}', '${psq(s.SessionId)}', ${level.toFixed(4)}, 0, 0)`,
        ),
      t('mixer.applied'),
    ).then(() => sessState.reload());

  const toggleSessionMute = (s: SessRow) =>
    guard(
      () =>
        apply(
          `[WFWeb.Audio]::SetSession('${psq(activeId)}', '${psq(s.SessionId)}', -1, 1, ${s.Muted ? 0 : 1})`,
        ),
      s.Muted ? t('mixer.unmuted') : t('mixer.muted'),
    ).then(() => sessState.reload());

  const makeDefault = () => {
    if (!activeId || activeDevice?.IsDefault) return;
    void guard(
      () => apply(`[WFWeb.Audio]::SetDefault('${psq(activeId)}')`),
      t('mixer.defaultChanged'),
    ).then(reloadAll);
  };

  const canSetDefault = !!activeDevice && !activeDevice.IsDefault;

  return (
    <div className="mod">
      <ModuleToolbar>
        <button className="mini" onClick={reloadAll} disabled={busy}>
          ⟳ {t('mixer.rescan')}
        </button>
        <span className="count-note">
          {t('mixer.deviceCount', { devs: devices.length })} · {t('mixer.appCount', { apps: sessions.length })}
        </span>
      </ModuleToolbar>

      <p className="count-note" style={{ marginTop: 0 }}>
        {t('mixer.blurb')}
      </p>

      {/* Output-device picker + set-default. */}
      <div className="mod-toolbar">
        <label className="count-note" style={{ marginRight: 4 }}>
          {t('mixer.outputDevice')}
        </label>
        <select
          className="mod-search"
          style={{ maxWidth: 380 }}
          value={activeId}
          disabled={busy || devices.length === 0}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {devices.length === 0 && <option value="">{t('mixer.noDevices')}</option>}
          {devices.map((d) => (
            <option key={d.Id} value={d.Id}>
              {d.Name}
              {d.IsDefault ? t('mixer.defaultSuffix') : ''}
            </option>
          ))}
        </select>
        <button className="mini" onClick={makeDefault} disabled={busy || !canSetDefault}>
          {t('mixer.setDefault')}
        </button>
        {activeDevice?.IsDefault && <StatusDot ok label={t('mixer.isDefault')} />}
      </div>

      {msg && <p className="mod-msg">{msg}</p>}

      <AsyncState loading={devState.loading} error={devState.error}>
        {/* Master card for the active device. */}
        {activeDevice && (
          <div className="mixer-card master">
            <MixerRow
              title={t('mixer.deviceMaster')}
              sub={activeDevice.Name}
              level={activeDevice.Level}
              muted={activeDevice.Muted}
              disabled={busy}
              onLevel={setMasterLevel}
              onMute={() => toggleMasterMute(!activeDevice.Muted)}
              muteLabel={t('mixer.muteToggle')}
            />
          </div>
        )}

        {/* Per-app sessions. */}
        <AsyncState loading={sessState.loading} error={sessState.error}>
          {sessions.length === 0 ? (
            <p className="count-note">{t('mixer.noApps')}</p>
          ) : (
            sessions.map((s) => (
              <div className="mixer-card" key={s.SessionId || `${s.Pid}-${s.Name}`}>
                <MixerRow
                  title={s.Name}
                  sub={s.IsSystem ? t('mixer.systemSounds') : s.Pid > 0 ? `PID ${s.Pid}` : ''}
                  level={s.Level}
                  muted={s.Muted}
                  disabled={busy || !s.SessionId}
                  onLevel={(v) => setSessionLevel(s, v)}
                  onMute={() => toggleSessionMute(s)}
                  muteLabel={t('mixer.muteToggle')}
                />
              </div>
            ))
          )}
        </AsyncState>
      </AsyncState>

      <style>{MIXER_CSS}</style>
    </div>
  );
}

function MixerRow({
  title,
  sub,
  level,
  muted,
  disabled,
  onLevel,
  onMute,
  muteLabel,
}: {
  title: string;
  sub: string;
  level: number;
  muted: boolean;
  disabled: boolean;
  onLevel: (level: number) => void;
  onMute: () => void;
  muteLabel: string;
}) {
  // Local slider state so dragging is smooth; commit on release.
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? pct(level);
  return (
    <div className="mixer-row">
      <button
        className={`mini mute-btn${muted ? ' primary' : ''}`}
        title={muteLabel}
        aria-label={muteLabel}
        disabled={disabled}
        onClick={onMute}
      >
        {muted ? '🔇' : '🔊'}
      </button>
      <div className="mixer-mid">
        <div className="mixer-title" title={title}>
          {title}
          {sub && <span className="mixer-sub"> · {sub}</span>}
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={shown}
          disabled={disabled}
          onChange={(e) => setDraft(Number(e.target.value))}
          onMouseUp={() => {
            if (draft !== null) {
              onLevel(draft / 100);
              setDraft(null);
            }
          }}
          onKeyUp={() => {
            if (draft !== null) {
              onLevel(draft / 100);
              setDraft(null);
            }
          }}
        />
      </div>
      <span className="mixer-pct">{shown}%</span>
    </div>
  );
}

const MIXER_CSS = `
.mixer-card { border: 1px solid var(--border, #2a2a2a); border-radius: 8px; padding: 10px 14px; margin: 8px 0; background: var(--card-bg, rgba(255,255,255,0.02)); }
.mixer-card.master { background: var(--card-bg-2, rgba(120,160,255,0.06)); }
.mixer-row { display: flex; align-items: center; gap: 12px; }
.mute-btn { min-width: 40px; font-size: 15px; }
.mixer-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mixer-title { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mixer-sub { font-weight: 400; font-size: 11px; opacity: 0.6; }
.mixer-mid input[type='range'] { width: 100%; }
.mixer-pct { min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.8; }
`;
