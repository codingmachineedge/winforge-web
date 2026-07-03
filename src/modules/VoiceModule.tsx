import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isTauri, runPowershell, runPowershellJson } from '../tauri/bridge';

// Native module — Windows SAPI text-to-speech via the desktop backend (PowerShell + System.Speech).
// Enumerate installed voices, read text aloud, stop playback, or render to a WAV file.
// The browser has no SAPI engine, so the live actions run only inside the WinForge desktop app.

interface VoiceRow { name: string; culture: string; gender: string; display: string }

// PowerShell single-quote escape.
const esc = (s: string) => s.replace(/'/g, "''");

// List installed & enabled SAPI voices. Never throws (returns empty on failure).
function listVoicesScript(): string {
  return `Add-Type -AssemblyName System.Speech; ` +
    `$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    `$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { ` +
    `$vi=$_.VoiceInfo; $cul=if($vi.Culture){$vi.Culture.Name}else{''}; ` +
    `$disp=if($cul){"$($vi.Name) ($cul, $($vi.Gender))"}else{$vi.Name}; ` +
    `[pscustomobject]@{name=$vi.Name;culture=$cul;gender=$vi.Gender.ToString();display=$disp} }; ` +
    `$s.Dispose()`;
}

// Speak text aloud synchronously (blocks the backend call until finished, then returns).
function speakScript(text: string, voice: string, rate: number, volume: number): string {
  const sel = voice ? `try{ $s.SelectVoice('${esc(voice)}') }catch{}; ` : '';
  return `Add-Type -AssemblyName System.Speech; ` +
    `$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    sel +
    `$s.Rate=${rate}; $s.Volume=${volume}; ` +
    `$s.SetOutputToDefaultAudioDevice(); ` +
    `$s.Speak('${esc(text)}'); ` +
    `$s.Dispose(); 'ok'`;
}

// Render text to a WAV file on disk. `pathExpr` is a raw PowerShell expression that must
// evaluate to the destination path (so $env:USERPROFILE resolves on the backend). The final
// statement echoes the resolved path back to the caller.
function exportScript(text: string, voice: string, rate: number, volume: number, pathExpr: string): string {
  const sel = voice ? `try{ $s.SelectVoice('${esc(voice)}') }catch{}; ` : '';
  return `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; ` +
    `$dest=${pathExpr}; ` +
    `$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
    sel +
    `$s.Rate=${rate}; $s.Volume=${volume}; ` +
    `$s.SetOutputToWaveFile($dest); ` +
    `$s.Speak('${esc(text)}'); ` +
    `$s.SetOutputToNull(); $s.Dispose(); $dest`;
}

// Kill any running SAPI speech (the synchronous Speak has no cross-process cancel handle,
// so stopping just ends the PowerShell hosts driving playback).
function stopScript(): string {
  return `Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" | ` +
    `Where-Object { $_.CommandLine -like '*System.Speech*' -and $_.ProcessId -ne $PID } | ` +
    `ForEach-Object { try{ Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }catch{} }; 'ok'`;
}

const clampRate = (n: number) => Math.max(-10, Math.min(10, Math.round(n)));
const clampVol = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function VoiceModule() {
  const { t } = useTranslation();
  const desktop = isTauri();

  const [text, setText] = useState('');
  const [voices, setVoices] = useState<VoiceRow[]>([]);
  const [voice, setVoice] = useState('');
  const [rate, setRate] = useState(0);
  const [volume, setVolume] = useState(100);
  const [speaking, setSpeaking] = useState(false);
  const [busy, setBusy] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const loadVoices = async () => {
    if (!desktop) return;
    setBusy('load'); setStatus(null);
    try {
      const rows = await runPowershellJson<VoiceRow>(listVoicesScript());
      setVoices(rows);
      const first = rows[0];
      if (first) setVoice(first.name);
    } catch (e) {
      setVoices([]);
      setStatus({ kind: 'err', msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(''); setLoaded(true);
    }
  };

  useEffect(() => {
    if (desktop) void loadVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = async () => {
    if (!desktop || !text.trim()) {
      if (!text.trim()) setStatus({ kind: 'err', msg: t('voicem.nothingRead') });
      return;
    }
    setBusy('play'); setSpeaking(true); setStatus(null);
    try {
      const res = await runPowershell(speakScript(text, voice, clampRate(rate), clampVol(volume)));
      if (!res.success) setStatus({ kind: 'err', msg: res.stderr.trim() || `exit ${res.code}` });
    } catch (e) {
      setStatus({ kind: 'err', msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(''); setSpeaking(false);
    }
  };

  const stop = async () => {
    if (!desktop) return;
    try {
      await runPowershell(stopScript());
    } catch {
      // ignore — best-effort stop
    } finally {
      setSpeaking(false);
    }
  };

  const exportWav = async () => {
    if (!desktop || !text.trim()) {
      if (!text.trim()) setStatus({ kind: 'err', msg: t('voicem.nothingExport') });
      return;
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const pathExpr = `Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WinForge-speech-${stamp}.wav'`;
    setBusy('export'); setStatus(null);
    try {
      const res = await runPowershell(exportScript(text, voice, clampRate(rate), clampVol(volume), pathExpr));
      const outPath = res.stdout.trim().split('\n').pop()?.trim() ?? '';
      if (res.success && outPath) {
        setStatus({ kind: 'ok', msg: t('voicem.exportedTo', { path: outPath }) });
      } else {
        setStatus({ kind: 'err', msg: res.stderr.trim() || `exit ${res.code}` });
      }
    } catch (e) {
      setStatus({ kind: 'err', msg: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy('');
    }
  };

  const canAct = desktop && voices.length > 0 && !busy;

  return (
    <div className="mod">
      <p className="count-note">{t('voicem.blurb')}</p>
      {!desktop && (
        <p className="count-note" style={{ color: 'var(--danger)' }}>{t('voicem.desktopOnly')}</p>
      )}

      <div className="io-grid" style={{ marginTop: 8 }}>
        <label className="label">{t('voicem.textLabel')}</label>
        <textarea
          className="hosts-edit"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('voicem.textPlaceholder')}
          disabled={!desktop}
        />
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        <label className="count-note">{t('voicem.voiceLabel')}</label>
        <select
          className="mod-select"
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          disabled={!desktop || voices.length === 0}
          style={{ maxWidth: 320 }}
        >
          {voices.length === 0 && <option value="">{t('voicem.noVoiceOption')}</option>}
          {voices.map((v) => (
            <option key={v.name} value={v.name}>{v.display}</option>
          ))}
        </select>
        <button className="mini" disabled={!desktop || !!busy} onClick={loadVoices}>
          {busy === 'load' ? t('voicem.loading') : t('voicem.refresh')}
        </button>
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 4 }}>
        <label className="count-note">{t('voicem.rateLabel')}</label>
        <input
          className="mod-search"
          type="number"
          min={-10}
          max={10}
          style={{ maxWidth: 80 }}
          value={rate}
          onChange={(e) => setRate(clampRate(+e.target.value))}
          disabled={!desktop}
        />
        <label className="count-note">{t('voicem.volumeLabel')}</label>
        <input
          className="mod-search"
          type="number"
          min={0}
          max={100}
          style={{ maxWidth: 80 }}
          value={volume}
          onChange={(e) => setVolume(clampVol(+e.target.value))}
          disabled={!desktop}
        />
      </div>

      <div className="mod-toolbar" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        <button className="mini primary" disabled={!canAct || speaking} onClick={play}>
          {busy === 'play' ? t('voicem.playing') : t('voicem.play')}
        </button>
        <button className="mini" disabled={!desktop || !speaking} onClick={stop}>
          {t('voicem.stop')}
        </button>
        <button className="mini" disabled={!canAct} onClick={exportWav}>
          {busy === 'export' ? t('voicem.exporting') : t('voicem.export')}
        </button>
      </div>

      {loaded && desktop && voices.length === 0 && !busy && (
        <p className="count-note dep-missing" style={{ marginTop: 8 }}>{t('voicem.noVoices')}</p>
      )}

      {status && (
        <pre className={status.kind === 'err' ? 'cmd-out error' : 'cmd-out'} style={{ marginTop: 8 }}>
          {status.msg}
        </pre>
      )}

      <p className="count-note">{t('voicem.note')}</p>
    </div>
  );
}
