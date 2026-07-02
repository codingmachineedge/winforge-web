// Maps WinForge module tags to a real, read-only backend probe that runs on the
// desktop (Tauri) build. This is what turns "native-only" cards from inert stubs
// into modules that actually query the live system. Kept read-only/safe: listing,
// status, and info — no mutation. Frontend renders a Run button + output for any
// module whose tag appears here (only when isTauri()).
import { runPowershell, systemInfo, type CommandOutput } from './bridge';

export interface NativeAction {
  labelEn: string;
  labelZh: string;
  run: () => Promise<string>;
}

const ps = (script: string) => async (): Promise<string> => {
  const out: CommandOutput = await runPowershell(script);
  const body = out.stdout.trim() || out.stderr.trim();
  return body || `(no output, exit ${out.code})`;
};

export const nativeActions: Record<string, NativeAction> = {
  'module.monitor': {
    labelEn: 'Top processes by CPU',
    labelZh: '依 CPU 排序的程序',
    run: ps(
      'Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Name,Id,CPU,@{N="WS(MB)";E={[math]::Round($_.WS/1MB,1)}} | Format-Table -AutoSize | Out-String -Width 200',
    ),
  },
  'module.procexp': {
    labelEn: 'Process list',
    labelZh: '程序清單',
    run: ps(
      'Get-Process | Select-Object -First 40 Id,ProcessName,@{N="WS(MB)";E={[math]::Round($_.WS/1MB,1)}},Path | Format-Table -AutoSize | Out-String -Width 220',
    ),
  },
  'module.services': {
    labelEn: 'Windows services',
    labelZh: 'Windows 服務',
    run: ps(
      'Get-Service | Select-Object -First 60 Status,Name,DisplayName | Format-Table -AutoSize | Out-String -Width 200',
    ),
  },
  'module.startup': {
    labelEn: 'Startup programs',
    labelZh: '開機程式',
    run: ps(
      'Get-CimInstance Win32_StartupCommand | Select-Object Name,Location,Command | Format-Table -AutoSize | Out-String -Width 220',
    ),
  },
  'module.tasks': {
    labelEn: 'Scheduled tasks',
    labelZh: '排程工作',
    run: ps(
      'Get-ScheduledTask | Where-Object State -ne "Disabled" | Select-Object -First 50 TaskName,State,TaskPath | Format-Table -AutoSize | Out-String -Width 200',
    ),
  },
  'module.connections': {
    labelEn: 'Active TCP connections',
    labelZh: '使用中的 TCP 連線',
    run: ps(
      'Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Select-Object -First 40 LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess | Format-Table -AutoSize | Out-String -Width 200',
    ),
  },
  'module.envvars': {
    labelEn: 'Environment variables',
    labelZh: '環境變數',
    run: ps('Get-ChildItem Env: | Sort-Object Name | Format-Table -AutoSize Name,Value | Out-String -Width 240'),
  },
  'module.drives': {
    labelEn: 'Drives & free space',
    labelZh: '磁碟機與可用空間',
    run: ps(
      'Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{N="Used(GB)";E={[math]::Round($_.Used/1GB,1)}},@{N="Free(GB)";E={[math]::Round($_.Free/1GB,1)}},Root | Format-Table -AutoSize | Out-String -Width 200',
    ),
  },
  'module.disk': {
    labelEn: 'Volumes',
    labelZh: '磁碟區',
    run: ps(
      'Get-Volume | Select-Object DriveLetter,FileSystemLabel,FileSystem,@{N="Size(GB)";E={[math]::Round($_.Size/1GB,1)}},@{N="Free(GB)";E={[math]::Round($_.SizeRemaining/1GB,1)}} | Format-Table -AutoSize | Out-String -Width 200',
    ),
  },
  'module.devices': {
    labelEn: 'Plug-and-play devices',
    labelZh: '隨插即用裝置',
    run: ps(
      'Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Select-Object -First 50 Status,Class,FriendlyName | Format-Table -AutoSize | Out-String -Width 200',
    ),
  },
  'module.events': {
    labelEn: 'Recent System events',
    labelZh: '最近的系統事件',
    run: ps(
      'Get-WinEvent -LogName System -MaxEvents 25 -ErrorAction SilentlyContinue | Select-Object TimeCreated,Id,LevelDisplayName,ProviderName | Format-Table -AutoSize | Out-String -Width 220',
    ),
  },
  'module.battery': {
    labelEn: 'Battery & power',
    labelZh: '電池與電源',
    run: ps(
      'Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object EstimatedChargeRemaining,BatteryStatus,DesignCapacity,FullChargeCapacity | Format-List | Out-String; powercfg /getactivescheme',
    ),
  },
  'module.winfetch': {
    labelEn: 'System information',
    labelZh: '系統資訊',
    run: async () => {
      const si = await systemInfo();
      const os = await runPowershell(
        '(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture,@{N="RAM(GB)";E={[math]::Round($_.TotalVisibleMemorySize/1MB,1)}} | Format-List | Out-String).Trim()',
      );
      return (
        `Host:   ${si.hostname}\n` +
        `OS:     ${si.os} (${si.family})\n` +
        `Arch:   ${si.arch}\n` +
        `CPUs:   ${si.cpus}\n` +
        `Exe:    ${si.exe}\n\n` +
        os.stdout.trim()
      );
    },
  },
  'module.hosts': {
    labelEn: 'Hosts file',
    labelZh: 'hosts 檔案',
    run: ps('Get-Content "$env:SystemRoot\\System32\\drivers\\etc\\hosts" -ErrorAction SilentlyContinue | Out-String'),
  },
};

export function actionFor(tag: string): NativeAction | undefined {
  return nativeActions[tag];
}
