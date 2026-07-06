import { describe, expect, it } from 'vitest';
import { regProviderPath, readScript, setScript, deleteScript } from './registry';

// These builders drive REAL registry writes in the desktop app, so their output is pinned
// exactly. Each mirrors WinForge's RegistryHelper (ValueEquals / SetValue / DeleteValue).
describe('registry PowerShell builders', () => {
  it('builds hive-explicit provider paths', () => {
    expect(regProviderPath('HKCU', 'Software\\Microsoft\\Windows\\DWM')).toBe(
      'Registry::HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\DWM',
    );
    expect(regProviderPath('HKLM', 'SYSTEM\\CurrentControlSet')).toBe(
      'Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet',
    );
  });

  it('reads a value and echoes it only when set', () => {
    expect(readScript('HKCU', 'Control Panel\\Desktop', 'DragFullWindows')).toBe(
      "$ErrorActionPreference='SilentlyContinue'; " +
        "$v = (Get-ItemProperty -LiteralPath 'Registry::HKEY_CURRENT_USER\\Control Panel\\Desktop' -Name 'DragFullWindows' -ErrorAction SilentlyContinue).'DragFullWindows'; " +
        'if ($null -ne $v) { "$v" }',
    );
  });

  it('writes DWord values bare (create-key-if-needed)', () => {
    expect(setScript('HKCU', 'Software\\...\\Personalize', 'EnableTransparency', 1, 'DWord')).toBe(
      "$ErrorActionPreference='Stop'; " +
        "if (-not (Test-Path -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\...\\Personalize')) { New-Item -Path 'Registry::HKEY_CURRENT_USER\\Software\\...\\Personalize' -Force | Out-Null }; " +
        "New-ItemProperty -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\...\\Personalize' -Name 'EnableTransparency' -Value 1 -PropertyType DWord -Force | Out-Null",
    );
  });

  it('writes String values quoted', () => {
    const s = setScript('HKCU', 'Control Panel\\Desktop\\WindowMetrics', 'MinAnimate', '1', 'String');
    expect(s).toContain("-Value '1' -PropertyType String -Force");
  });

  it('coerces a numeric-string DWord to a bare number', () => {
    expect(setScript('HKCU', 'X', 'N', '2', 'DWord')).toContain('-Value 2 -PropertyType DWord');
  });

  it('deletes a value (used when a toggle offValue is null)', () => {
    expect(deleteScript('HKCU', 'Software\\X', 'JPEGImportQuality')).toBe(
      "Remove-ItemProperty -LiteralPath 'Registry::HKEY_CURRENT_USER\\Software\\X' -Name 'JPEGImportQuality' -Force -ErrorAction SilentlyContinue",
    );
  });

  it('escapes single quotes in path and name', () => {
    expect(setScript('HKCU', "a'b", "n'm", 1, 'DWord')).toContain(
      "New-ItemProperty -LiteralPath 'Registry::HKEY_CURRENT_USER\\a''b' -Name 'n''m'",
    );
  });
});
