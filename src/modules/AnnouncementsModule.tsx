import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModuleToolbar, StatusDot } from './common';

// Port of WinForge Pages/AnnouncementsModule + AnnouncementService: speak
// public-address announcements through the speakers, with a queue (urgent
// jumps it), an optional two-tone chime, and voice/volume/rate controls.
// Uses the Web Speech API (SpeechSynthesis) + Web Audio for the chime, so it
// is fully self-contained and runs in the browser and the desktop app.

interface Voice {
  name: string;
  lang: string;
}

const PRESETS = [
  { id: 'attention', en: 'Attention please. May I have your attention.', zh: '請注意。唔該大家注意。' },
  { id: 'test', en: 'This is a test of the public address system.', zh: '呢個係廣播系統測試。' },
  { id: 'break', en: 'It is now time for a short break.', zh: '而家係小休時間。' },
  { id: 'closing', en: 'The building will be closing in fifteen minutes.', zh: '大樓將於十五分鐘後關閉。' },
  { id: 'evac', en: 'Please evacuate calmly using the nearest exit.', zh: '請由最近嘅出口冷靜疏散。' },
];

function playChime(): Promise<void> {
  return new Promise((resolve) => {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return resolve();
    const ctx = new AC();
    const now = ctx.currentTime;
    const tone = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.3, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur);
    };
    tone(660, 0, 0.35); // two-tone "ding-dong"
    tone(520, 0.35, 0.45);
    setTimeout(() => {
      ctx.close();
      resolve();
    }, 900);
  });
}

export function AnnouncementsModule() {
  const { t, i18n } = useTranslation();
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceName, setVoiceName] = useState('');
  const [volume, setVolume] = useState(80);
  const [rate, setRate] = useState(0); // -10..+10
  const [chime, setChime] = useState(true);
  const [urgent, setUrgent] = useState(false);
  const [bothLang, setBothLang] = useState(false);
  const [message, setMessage] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const queue = useRef<string[]>([]);

  useEffect(() => {
    if (!supported) return;
    const load = () => {
      const vs = window.speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang }));
      setVoices(vs);
      if (!voiceName && vs.length) setVoiceName(vs[0]!.name);
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  const speakOne = (text: string): Promise<void> =>
    new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = window.speechSynthesis.getVoices().find((x) => x.name === voiceName);
      if (v) u.voice = v;
      u.volume = Math.max(0, Math.min(1, volume / 100));
      u.rate = Math.max(0.1, Math.min(2, 1 + rate / 10)); // -10..+10 -> 0..2
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });

  const runQueue = async () => {
    setSpeaking(true);
    while (queue.current.length) {
      const next = queue.current.shift()!;
      if (chime) await playChime();
      await speakOne(next);
    }
    setSpeaking(false);
  };

  const announce = (text: string) => {
    const t0 = text.trim();
    if (!t0 || !supported) return;
    if (urgent) {
      window.speechSynthesis.cancel();
      queue.current.unshift(t0);
    } else {
      queue.current.push(t0);
    }
    if (bothLang) {
      // Follow the primary text with the alternate-language variant when a preset
      // supplies one; for free text this just repeats it once.
      const preset = PRESETS.find((p) => p.en === t0 || p.zh === t0);
      if (preset) queue.current.push(i18n.language === 'en' ? preset.zh : preset.en);
    }
    if (!speaking) void runQueue();
  };

  const stop = () => {
    queue.current = [];
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  };

  if (!supported) {
    return (
      <div className="mod">
        <p className="count-note">{t('announcements.unsupported')}</p>
      </div>
    );
  }

  return (
    <div className="mod">
      <ModuleToolbar>
        <StatusDot ok={speaking} label={speaking ? t('announcements.speaking') : t('announcements.idle')} />
        <button className="mini" onClick={() => void playChime()}>{t('announcements.testChime')}</button>
        <button className="mini" onClick={stop} disabled={!speaking && queue.current.length === 0}>{t('announcements.stop')}</button>
      </ModuleToolbar>
      <p className="count-note">{t('announcements.blurb')}</p>

      <div className="panel" style={{ marginBottom: 10, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
        <label>
          {t('announcements.voice')}{' '}
          <select value={voiceName} onChange={(e) => setVoiceName(e.target.value)}>
            {voices.map((v) => (
              <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {t('announcements.volume')}
          <input type="range" min={0} max={100} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
          <span style={{ width: 32 }}>{volume}</span>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {t('announcements.rate')}
          <input type="range" min={-10} max={10} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
          <span style={{ width: 32 }}>{rate > 0 ? `+${rate}` : rate}</span>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={chime} onChange={(e) => setChime(e.target.checked)} /> {t('announcements.chime')}
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} /> {t('announcements.urgent')}
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={bothLang} onChange={(e) => setBothLang(e.target.checked)} /> {t('announcements.both')}
        </label>
      </div>

      <div className="panel" style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          className="mod-search"
          style={{ flex: '1 1 320px' }}
          placeholder={t('announcements.placeholder')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && announce(message)}
        />
        <button className="mini primary" onClick={() => announce(message)} disabled={!message.trim()}>{t('announcements.speak')}</button>
      </div>

      <p className="count-note">{t('announcements.presets')}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {PRESETS.map((p) => {
          const text = i18n.language === 'en' ? p.en : p.zh;
          return (
            <button key={p.id} className="mini" onClick={() => announce(text)}>{text.slice(0, 32)}{text.length > 32 ? '…' : ''}</button>
          );
        })}
      </div>
    </div>
  );
}
