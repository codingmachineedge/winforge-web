// 數位反應性計算機（反應性計）· Digital inverse-point-kinetics REACTIVITY COMPUTER (reactimeter).
//
// A framework-free TypeScript port of WinForge's C# `ReactivityComputer` (Services/ReactorReactivityMeter.cs).
// It reconstructs the net core reactivity ρ(t) PURELY from the measured neutron-flux signal n(t) by
// inverting the six-group point-kinetics equations — it must NOT read the engine's internally-computed
// reactivity. Because it solves its own kinetics (its own reconstructed precursors, its own filtered flux
// derivative), it tracks but does not exactly echo the true ρ, with a small authentic dynamic lag during
// fast transients — exactly as a field reactimeter behaves. That independence is the point: it lets the
// operator MEASURE an unknown rod/boron worth from the flux response alone (startup physics testing).
//
//   forward:  dn/dt = ((ρ−β)/Λ*)·n + Σ λ_i C_i ,   dC_i/dt = (β_i/Λ*)·n − λ_i C_i
//   inverse:  ρ(t) = β_eff + (Λ*/n)·(dn/dt − Σ λ_i C_i)

const FluxFilterTau = 0.8; // s — input flux EMA for a clean derivative
const RhoFilterTau = 0.5; // s — output ρ display smoothing
const RateDeadband = 1.0e-4; // 1/s — |d ln n/dt| below this → "steady", period → ∞
const FloorFraction = 1.0e-9; // n floor for division guards (≈ source level)
const SurPerInvSec = 26.05568; // 60/ln(10): Startup-Rate DPM per (1/T), T in s
const PositiveRateAlarmDpm = 1.0; // advisory: > +1 DPM is a brisk positive transient

function oneMinusExp(x: number): number {
  if (x < 1e-5) return x * (1.0 - 0.5 * x * (1.0 - x / 3.0));
  return 1.0 - Math.exp(-x);
}

export class Reactimeter {
  private readonly beta: Float64Array;
  private readonly lambda: Float64Array;
  private readonly promptLife: number;
  private readonly betaTotalBol: number;
  private readonly c = new Float64Array(6); // reconstructed precursors

  private nFilt = 1.0;
  private nFiltPrev = 1.0;
  private nPrev = 1.0;
  private rhoFilt = 0;
  private markPcm = 0;
  private _hasMark = false;

  reactivityPcm = 0;
  reactivityDollars = 0;
  periodSeconds = 1e9;
  startupRateDpm = 0;
  positiveRateAlarm = false;
  measuredWorthDollars = 0;

  constructor(beta: Float64Array, lambda: Float64Array, promptLifetime: number) {
    this.beta = beta.slice();
    this.lambda = lambda.slice();
    this.promptLife = promptLifetime;
    let s = 0;
    for (const b of this.beta) s += b;
    this.betaTotalBol = s;
  }

  get hasMark(): boolean {
    return this._hasMark;
  }
  get measuredWorthPcm(): number {
    return this._hasMark ? this.reactivityPcm - this.markPcm : 0.0;
  }

  /** Seed the reconstructed precursors to the assumed-critical steady state for the current flux. */
  reset(n0: number, betaCycleFactor: number): void {
    const n = Math.max(n0, FloorFraction);
    for (let i = 0; i < 6; i++) this.c[i] = (betaCycleFactor * this.beta[i]!) / (this.promptLife * this.lambda[i]!) * n;
    this.nFilt = this.nFiltPrev = this.nPrev = n;
    this.rhoFilt = 0;
    this.reactivityPcm = 0;
    this.reactivityDollars = 0;
    this.periodSeconds = 1e9;
    this.startupRateDpm = 0;
    this.positiveRateAlarm = false;
    this._hasMark = false;
    this.markPcm = 0;
    this.measuredWorthDollars = 0;
  }

  /** Capture the current measured reactivity as the baseline for a worth measurement. */
  mark(): void {
    this.markPcm = this.reactivityPcm;
    this._hasMark = true;
  }
  clearMark(): void {
    this._hasMark = false;
    this.markPcm = 0;
    this.measuredWorthDollars = 0;
  }

  /** Advance one tick from the measured flux only. */
  update(nMeasured: number, dt: number, betaCycleFactor: number, sourceFloor: number): void {
    if (dt < 1.0e-4) return;
    const floor = Math.max(FloorFraction, sourceFloor);
    const n1 = Math.max(nMeasured, floor);
    const n0 = Math.max(this.nPrev, floor);
    const betaEff = this.betaTotalBol * betaCycleFactor;

    // precursor reconstruction: analytic exponential integrator, piecewise-LINEAR source (n0→n1)
    let precursorSum = 0.0;
    for (let i = 0; i < 6; i++) {
      const x = this.lambda[i]! * dt;
      const om = oneMinusExp(x);
      const e = 1.0 - om;
      const srcCoef = (betaCycleFactor * this.beta[i]!) / (this.promptLife * this.lambda[i]!);
      const drive = n1 - (n1 - n0) * (om / x);
      this.c[i] = this.c[i]! * e + srcCoef * om * drive;
      if (this.c[i]! < 0) this.c[i] = 0;
      precursorSum += this.lambda[i]! * this.c[i]!;
    }

    // filtered flux derivative (prompt-jump term)
    const aFlux = Math.min(1.0, dt / FluxFilterTau);
    this.nFilt += (nMeasured - this.nFilt) * aFlux;
    const nDivPrompt = Math.max(this.nFilt, floor);
    const dndt = (this.nFilt - this.nFiltPrev) / dt;
    this.nFiltPrev = this.nFilt;

    // inverse point kinetics
    const rho = betaEff + (this.promptLife / nDivPrompt) * (dndt - precursorSum);
    const aRho = Math.min(1.0, dt / RhoFilterTau);
    this.rhoFilt += (rho - this.rhoFilt) * aRho;
    this.reactivityPcm = this.rhoFilt * 1.0e5;
    this.reactivityDollars = betaEff > 1e-9 ? this.rhoFilt / betaEff : 0.0;
    this.measuredWorthDollars = betaEff > 1e-9 ? (this.measuredWorthPcm * 1e-5) / betaEff : 0.0;

    // asymptotic period & startup rate from the logarithmic flux rate
    const dlnn = dndt / nDivPrompt;
    if (Math.abs(dlnn) < RateDeadband) {
      this.periodSeconds = (dlnn >= 0 ? 1.0 : -1.0) * 1e9;
      this.startupRateDpm = 0.0;
      this.positiveRateAlarm = false;
    } else {
      this.periodSeconds = 1.0 / dlnn;
      this.startupRateDpm = SurPerInvSec * dlnn;
      this.positiveRateAlarm = this.startupRateDpm > PositiveRateAlarmDpm;
    }

    this.nPrev = nMeasured;
  }
}
