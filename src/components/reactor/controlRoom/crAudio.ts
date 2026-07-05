// Control-room soundscape — ported from the Reactor Control Room design prototype:
// ambient reactor/turbine-hall hum that swells with power, neutron-detector clicks whose rate
// follows the log source-range count rate, a two-tone alarm klaxon gated by unacked annunciators,
// and the SCRAM whoop. Everything is synthesized with WebAudio; nothing is fetched. OFF by
// default — the operator opts in with the sound toggle.

export class ControlRoomAudio {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private humGain: GainNode | null = null;
  private humOsc1: OscillatorNode | null = null;
  private humOsc2: OscillatorNode | null = null;
  private alarmOsc: OscillatorNode | null = null;
  private alarmGain: GainNode | null = null;
  on = false;

  private init(): void {
    if (this.ac) return;
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      this.ac = ac;
      const master = ac.createGain();
      master.gain.value = 0.0;
      master.connect(ac.destination);
      this.master = master;
      // ambient reactor / turbine-hall hum
      const h1 = ac.createOscillator();
      h1.type = 'sawtooth';
      h1.frequency.value = 55;
      const h2 = ac.createOscillator();
      h2.type = 'sine';
      h2.frequency.value = 110;
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 210;
      lp.Q.value = 0.7;
      const humGain = ac.createGain();
      humGain.gain.value = 0.0;
      h1.connect(lp);
      h2.connect(lp);
      lp.connect(humGain);
      humGain.connect(master);
      h1.start();
      h2.start();
      this.humOsc1 = h1;
      this.humOsc2 = h2;
      this.humGain = humGain;
      // alarm klaxon: two-tone square through a bandpass
      const al = ac.createOscillator();
      al.type = 'square';
      al.frequency.value = 500;
      const alBand = ac.createBiquadFilter();
      alBand.type = 'bandpass';
      alBand.frequency.value = 600;
      alBand.Q.value = 1.2;
      const alGain = ac.createGain();
      alGain.gain.value = 0.0;
      al.connect(alBand);
      alBand.connect(alGain);
      alGain.connect(master);
      al.start();
      this.alarmOsc = al;
      this.alarmGain = alGain;
    } catch {
      this.ac = null;
    }
  }

  toggle(): boolean {
    this.on = !this.on;
    if (this.on) {
      this.init();
      if (this.ac && this.ac.state === 'suspended') void this.ac.resume();
    }
    if (this.master && this.ac) this.master.gain.setTargetAtTime(this.on ? 0.9 : 0.0, this.ac.currentTime, 0.05);
    return this.on;
  }

  dispose(): void {
    try {
      if (this.ac) void this.ac.close();
    } catch {
      /* already closed */
    }
    this.ac = null;
    this.on = false;
  }

  private clickTick(): void {
    if (!this.ac || !this.master) return;
    try {
      const ac = this.ac;
      const t = ac.currentTime;
      const o = ac.createOscillator();
      o.type = 'square';
      o.frequency.value = 1400 + Math.random() * 500;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200;
      bp.Q.value = 2;
      o.connect(bp);
      bp.connect(g);
      g.connect(this.master);
      o.start(t);
      o.stop(t + 0.02);
    } catch {
      /* transient node failure — skip the click */
    }
  }

  scramWhoop(): void {
    if (!this.on || !this.ac || !this.master) return;
    try {
      const ac = this.ac;
      const t = ac.currentTime;
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(820, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 1.1);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.28, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      o.connect(g);
      g.connect(this.master);
      o.start(t);
      o.stop(t + 1.25);
    } catch {
      /* ignore */
    }
  }

  /** Per-tick update: hum tracks power, klaxon gates on unacked alarms, geiger clicks follow SR cps. */
  update(powerFraction: number, sourceRangeCps: number, flashing: number, tick: number, speed: number): void {
    if (!this.on || !this.ac) return;
    const t = this.ac.currentTime;
    const pf = Math.min(1, powerFraction);
    if (this.humGain) this.humGain.gain.setTargetAtTime(0.03 + 0.09 * pf, t, 0.3);
    if (this.humOsc1) this.humOsc1.frequency.setTargetAtTime(52 + 26 * pf, t, 0.4);
    if (this.humOsc2) this.humOsc2.frequency.setTargetAtTime(104 + 40 * pf, t, 0.4);
    if (this.alarmGain) this.alarmGain.gain.setTargetAtTime(flashing > 0 ? 0.07 : 0.0, t, 0.04);
    if (this.alarmOsc && flashing > 0) this.alarmOsc.frequency.setValueAtTime(tick % 6 < 3 ? 500 : 660, t);
    const ratePerSec = Math.max(0, Math.min(16, (Math.log10(Math.max(1, sourceRangeCps)) - 1.5) * 3.5));
    const perTick = ratePerSec * 0.1 * Math.max(1, speed);
    let n = Math.floor(perTick) + (Math.random() < perTick % 1 ? 1 : 0);
    n = Math.min(n, 6);
    for (let i = 0; i < n; i++) window.setTimeout(() => this.clickTick(), Math.random() * 90);
  }
}
