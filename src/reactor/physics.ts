// 反應堆點動力學物理引擎 · PWR point-kinetics physics engine.
//
// A pure, deterministic, framework-free TypeScript port of the core of WinForge's C#
// `ReactorSimService` (Services/ReactorSimService.cs). It reproduces the load-bearing physics
// that drives the four control-room gauges — thermal power (熱功率), reactivity (反應性),
// fuel temperature (燃料溫度) and coolant temperature (冷卻劑溫度) — plus the supporting
// systems the operator drives them with:
//
//   • Six-group point kinetics integrated with unconditionally-stable backward (implicit) Euler,
//     with a neutron source so a subcritical core stays alive.
//   • Reactivity feedback: control-rod S-curve worth (4 Westinghouse banks), soluble-boron
//     differential worth (concentration-dependent DBW), fuel Doppler, moderator temperature
//     coefficient (MTC), equilibrium xenon and samarium poisons, fresh-core excess baseline and
//     fuel-cycle burnup defect.
//   • Lumped fuel/coolant thermal-hydraulics → FuelTemp, Tcold/Thot/Tavg, a saturated-pressurizer
//     primary pressure and programmed pressurizer level.
//   • ANS-5.1 23-group fission-product decay heat + a 2-group actinide chain (exact analytic
//     recurrence, present after a SCRAM — the reason loss-of-heat-sink transients are emergent).
//   • Reactor-coolant-pump flow with fast spin-up / hyperbolic flywheel coastdown and a
//     natural-circulation floor.
//   • Xe-135 / I-135 and Sm-149 / Pm-149 poison ODEs (normalized so equilibrium full power = 1).
//   • SCRAM with the trip-breaker/gripper release dead-time and gravity rod-drop dynamics.
//   • Fuel-cycle burnup → cycle fraction driving critical-boron letdown, β_eff drop and MTC EOL slope.
//   • A minimal Reactor Protection System (high flux, high startup rate / short period, high Thot,
//     high pressure, low flow) that auto-SCRAMs — suppressed by the beginner easy-startup mode.
//
// The numbers are engineering approximations tuned for plausibility and playability, matching the
// C# engine's calibration, not licensing accuracy. All constants carry their C# provenance.

export enum ReactorMode {
  Shutdown = 'Shutdown',
  Startup = 'Startup',
  Run = 'Run',
  Tripped = 'Tripped',
  Meltdown = 'Meltdown',
}

// ----------------------------------------------------------------- constants ----
// Six delayed-neutron groups (typical U-235 thermal values). Typed arrays so indexed access is
// `number` (not `number | undefined`) under the project's noUncheckedIndexedAccess.
const Beta = new Float64Array([0.000215, 0.001424, 0.001274, 0.002568, 0.000748, 0.000273]);
const Lambda = new Float64Array([0.0124, 0.0305, 0.111, 0.301, 1.14, 3.01]); // 1/s decay
const BetaTotal = Beta.reduce((a, b) => a + b, 0); // total delayed fraction
const PromptLifetime = 2.0e-5; // s, prompt neutron generation time (Lambda*)

// Reactivity coefficients (delta-k/k per unit) — tuned, plausible PWR magnitudes.
const DopplerCoeff = -2.8e-5; // per °C of fuel temp (Doppler, negative)
const ModTempCoeff = -2.0e-4; // per °C of moderator (coolant) temp (negative, MTC)
const BoronWorth = -9.5e-6; // per ppm boron — legacy SECANT worth at NominalBoron; live slope from DBW curve

// Differential boron worth (DBW) vs concentration: |dρ/dC| grows as boron is diluted out.
// DBW(C) = −(b0 − b1·C); its integral ρ_B(C) = −(b0·C − ½·b1·C²) is concave.
const DbwB0Phys = 1.05e-4; // |DBW| at 0 ppm (10.5 pcm/ppm)
const DbwB1Phys = 1.75e-8; // roll-off slope (Δk/ppm²) → |DBW(2000 ppm)| = 7.0 pcm/ppm
const NominalBoron = 1200.0; // ppm at BOL hot-zero-power-ish

const DbwPhysIntegral = (c: number) => -(DbwB0Phys * c - 0.5 * DbwB1Phys * c * c);
// Single rescale so ρ_B(NominalBoron) == legacy BoronWorth·NominalBoron (nominal balance preserved).
const DbwScale = (BoronWorth * NominalBoron) / DbwPhysIntegral(NominalBoron);
const BoronRhoTotal = (c: number) => DbwScale * DbwPhysIntegral(c);
const BoronDiffWorth = (c: number) => DbwScale * -(DbwB0Phys - DbwB1Phys * c);

const XenonWorthFull = -0.028; // dk/k at equilibrium full-power xenon (~ -2800 pcm)
const SamariumWorthFull = -0.0064; // dk/k at equilibrium full-power samarium (~ -640 pcm)

// Fuel-cycle core depletion (burnup-dependent reactivity). base + slope·f, f = cycle fraction.
const CycleEndBurnupMwd = 18000.0; // MWd/tonneU ≈ 18 GWd/tU per 18-month cycle
const MtcEolSlope = -2.0e-4; // /°C per unit f: MTC −2.0e-4 (BOL) → −4.0e-4 (EOL)
const BetaEolDrop = 0.1; // β_eff fractional drop at EOL (0.0065 → 0.00585)
const EolBoronPpm = 10.0; // critical-boron endpoint at EOL HFP ARO

// Rod worth: total worth of all banks fully inserted (dk/k). Banks share this.
const TotalRodWorth = 0.08; // 8000 pcm fully inserted

// Westinghouse rod geometry / per-bank integral-worth fractions (A,B,C,D), Σ = 1.
const RodStepsPerBank = 228;
const RodWorthFrac = new Float64Array([0.3, 0.27, 0.23, 0.2]);

// Reactor-trip rod-drop dynamics (gravity insertion after the trip breakers open).
const ROD_RELEASE_DELAY_S = 0.3; // s — trip-breaker + gripper-coil release dead-time
const RodDropFreeFallVel = 0.386; // fraction-of-stroke / s — drag-limited terminal velocity
const RodDropDashpotEntry = 0.85; // fraction inserted where the dashpot snubbing begins
const RodDropDashpotVelFac = 0.4; // velocity multiplier at the dashpot bottom (snubbing)

// Reference / nominal operating points.
export const RatedThermalMW = 3411.0; // MWth (typical 4-loop PWR core)
export const RatedElectricMW = 1150.0; // MWe gross

const RefFuelTemp = 600.0; // °C reference fuel temp for Doppler datum
const RefModTemp = 305.0; // °C reference Tavg datum
const ColdTemp = 35.0; // °C cold shutdown coolant temp
const NominalTavg = 305.0; // °C
const NominalPressure = 15.5; // MPa primary pressure
const NominalPzrLevel = 55.0; // % pressurizer level

// Easy-startup beginner assist.
const EasyStartupAssistPcm = 500.0; // +0.005 dk/k
const EasyStartupPowerLimit = 0.05; // assist only below 5% RTP
const EasyStartupBurnFactor = 1.75; // explicit fuel penalty for the beginner startup assist

// Limits / trip setpoints.
export const FuelMeltTemp = 2800.0; // °C
export const FuelDamageTemp = 1200.0; // °C — clad/fuel damage onset (sustained)
export const VesselPressureLimit = 17.2; // MPa
export const VesselBurstPressure = 19.0; // MPa
const HighPowerTrip = 1.18; // fraction (118 %)
const ShortPeriodTrip = 10.0; // s — trip on period shorter than this
const LowFlowTrip = 0.85; // fraction of nominal flow
const HighThotTrip = 345.0; // °C
const MeltdownDamageThreshold = 100.0; // accumulated damage → meltdown

// ANS-5.1 decay-heat groups (fraction-of-rated a_i, decay λ_i in 1/s). Σa ≈ 6.6% fission products.
const DecayA = new Float64Array([
  1.469351e-4, 4.968694e-3, 6.222313e-3, 6.714175e-3, 8.236273e-3, 9.513312e-3,
  4.612211e-3, 3.338658e-3, 6.461999e-3, 5.174812e-3, 2.958373e-3, 1.803488e-3,
  1.26034e-3, 9.817596e-4, 1.396227e-3, 1.082506e-3, 4.115313e-4, 9.338084e-6,
  5.792887e-4, 5.069596e-7, 7.187277e-6, 9.154065e-6, 2.382031e-5,
]);
const DecayLambda = new Float64Array([
  2.2138e1, 5.1587e-1, 1.9594e-1, 1.0314e-1, 3.3656e-2, 1.1681e-2, 3.587e-3,
  1.393e-3, 6.263e-4, 1.8906e-4, 5.4988e-5, 2.0958e-5, 1.001e-5, 2.5438e-6,
  6.6361e-7, 1.229e-7, 2.7213e-8, 4.3714e-9, 7.578e-10, 2.4786e-10, 2.2384e-13,
  2.46e-14, 1.5699e-14,
]);
// Actinide chain (U-239 t½≈23.45 min, Np-239 t½≈2.356 d) — adds ~0.38% at equilibrium.
const ActinideA = new Float64Array([2.5e-3, 1.3e-3]);
const ActinideLambda = new Float64Array([4.902e-4, 3.448e-6]); // 1/s

const CoreTonnesU = 100.0; // ~100 tonnes U in a large PWR core

// Saturated-water fit anchored to IAPWS, analytically invertible.
const SatA = 10.2958;
const SatB = 4668.6;

// Reactor-coolant-pump flow dynamics.
const RcpSpinUpTau = 1.5; // s per-pump first-order spin-up lag
const RcpCoastHalf = 8.0; // s flow-halving time of a tripped pump's coastdown
const RcpLoopShare = 0.25; // rated flow fraction carried by one of the 4 loops
const NatCircCoef = 0.16; // W∝Q^(1/3) coefficient
const NatCircMax = 0.08; // physical single-phase natural-circ ceiling (8% rated)
const NatCircDtMin = 8.0; // °C min hot-cold ΔT before a thermosiphon establishes
const NatCircHeadSpan = 20.0; // °C ΔT span over which the buoyancy head ramps in
const NatCircSinkSpan = 15.0; // °C primary-to-secondary head span gating the SG heat sink

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const isFiniteNum = (x: number) => Number.isFinite(x);

/** 1 − e^(−x) for x ≥ 0 without catastrophic cancellation for tiny x (the expm1 stand-in). */
function oneMinusExp(x: number): number {
  if (x < 1e-5) return x * (1.0 - 0.5 * x * (1.0 - x / 3.0)); // x − x²/2 + x³/6
  return 1.0 - Math.exp(-x);
}

/** Saturation pressure of water (MPa) at a given temperature (°C). */
function satPressAt(tC: number): number {
  tC = clamp(tC, 80.0, 373.0);
  return Math.exp(SatA - SatB / (tC + 273.15));
}

/** Saturation temperature of water (°C) at a given pressure (MPa). */
function satTempAt(mpa: number): number {
  mpa = clamp(mpa, 0.01, 22.0);
  return SatB / (SatA - Math.log(mpa)) - 273.15;
}

/** S-shaped normalized integral rod-worth curve. S(0)=0, S(1)=1, S(0.5)=0.5. */
function rodS(x: number): number {
  if (x <= 0.0) return 0.0;
  if (x >= 1.0) return 1.0;
  return x - Math.sin(2.0 * Math.PI * x) / (2.0 * Math.PI);
}

/** Reactivity component breakdown (pcm) for display. */
export interface ReactivityBreakdown {
  rod: number;
  boron: number;
  doppler: number;
  moderator: number;
  xenon: number;
  samarium: number;
}

/** Immutable snapshot of the reactor state for the UI / trends. */
export interface ReactorState {
  mode: ReactorMode;
  neutronPowerFraction: number;
  coreThermalPowerFraction: number;
  thermalPowerMW: number;
  electricPowerMW: number;
  reactivityPcm: number;
  reactivity: ReactivityBreakdown;
  reactorPeriodSeconds: number;
  fuelTemp: number;
  tavg: number;
  tcold: number;
  thot: number;
  primaryPressure: number;
  pressurizerLevel: number;
  coolantFlowFraction: number;
  boronPpm: number;
  targetBoronPpm: number;
  rodBankInsertion: number[]; // % inserted per bank (A,B,C,D)
  decayHeatFraction: number;
  xenon: number;
  iodine: number;
  samarium: number;
  burnupMwdPerTonne: number;
  cycleFraction: number;
  coreLifePhase: 'BOL' | 'MOL' | 'EOL';
  criticalBoronPpm: number;
  isScrammed: boolean;
  rodsDropping: boolean;
  keff: number;
  shutdownMarginPcm: number;
  lastTripEn: string;
  lastTripZh: string;
}

export class ReactorSim {
  // ---- kinetics ----
  private _power = 1e-6; // neutron power, fraction of rated (start ~ source level)
  private _precursor = new Float64Array(6);
  private _powerRate = 0;
  reactorPeriodSeconds = 1e9;
  reactivityPcm = 0;
  sourceLevel = 1e-8; // neutron source (keeps subcritical core alive)

  // reactivity breakdown (pcm)
  rodReactivityPcm = 0;
  boronReactivityPcm = 0;
  dopplerReactivityPcm = 0;
  moderatorReactivityPcm = 0;
  xenonReactivityPcm = 0;
  samariumReactivityPcm = 0;

  // ---- thermal-hydraulics ----
  fuelTemp = ColdTemp;
  tcold = ColdTemp;
  thot = ColdTemp;
  primaryPressure = 2.5;
  pressurizerLevel = NominalPzrLevel;
  private _tpzr = ColdTemp; // pressurizer liquid temperature (°C) — sets primary pressure
  private _prevLevel = NominalPzrLevel;
  electricPowerMW = 0;

  // ---- decay heat / burnup ----
  private _decayGroup = new Float64Array(DecayA.length);
  private _actinide = new Float64Array(ActinideA.length);
  decayHeatFraction = 0;
  burnupMwdPerTonne = 0;
  depletionAccel = 1.0; // fast-forward the cycle (×1 = real time)

  // ---- poisons ----
  iodine = 0;
  xenon = 0;
  private _pm = 0;
  private _sm = 0;

  // ---- flow ----
  private _rcpFlow = new Float64Array(4);
  coolantFlowFraction = 0;
  pumpedFlowFraction = 0;
  naturalCircFraction = 0;
  rcpCoasting = false;
  onNaturalCirc = false;

  // ---- boron ----
  boronPpm = NominalBoron;
  targetBoronPpm = NominalBoron;

  // ---- rods ----
  readonly rodBankInsertion = new Float64Array([100.0, 100.0, 100.0, 100.0]); // % inserted (A,B,C,D)

  // ---- controls / mode ----
  mode = ReactorMode.Shutdown;
  isScrammed = false;
  meltdownTriggered = false;
  damageAccumulation = 0;
  easyStartupMode = false;

  // feedwater / secondary (minimal)
  feedwaterFlow = 0;
  steamPressure = 0.5;
  private _rodsFailToInsert = false; // ATWS latch

  // rod-drop dynamics
  private _rodReleaseTimer = 0;
  rodDropElapsedS = 0;
  rodsDropping = false;

  // RPS
  lastTripFunctionEn = '';
  lastTripFunctionZh = '';

  constructor() {
    for (let i = 0; i < 6; i++)
      this._precursor[i] = ((this.betaCycleFactor * Beta[i]!) / (PromptLifetime * Lambda[i]!)) * this._power;
  }

  // ----------------------------------------------------------------- derived ----
  get tavg(): number {
    return (this.tcold + this.thot) / 2.0;
  }
  get thermalPowerMW(): number {
    return this._power * RatedThermalMW;
  }
  get neutronPowerFraction(): number {
    return this._power;
  }
  get coreThermalPowerFraction(): number {
    return this._power + this.decayHeatFraction;
  }
  /** Burnup fraction of the cycle (0 at BOL → 1 at EOL). */
  get cycleFraction(): number {
    return clamp(this.burnupMwdPerTonne / CycleEndBurnupMwd, 0.0, 1.0);
  }
  get coreLifePhase(): 'BOL' | 'MOL' | 'EOL' {
    const f = this.cycleFraction;
    return f < 0.15 ? 'BOL' : f > 0.85 ? 'EOL' : 'MOL';
  }
  /** Critical soluble-boron letdown curve: NominalBoron at BOL → EolBoronPpm at EOL. */
  get criticalBoronPpm(): number {
    return NominalBoron - (NominalBoron - EolBoronPpm) * this.cycleFraction;
  }
  /** β_eff cycle scale: 1 at BOL → 0.90 at EOL. */
  private get betaCycleFactor(): number {
    return 1.0 - BetaEolDrop * this.cycleFraction;
  }
  get betaEffectivePcm(): number {
    return BetaTotal * this.betaCycleFactor * 1e5;
  }
  get coreKeff(): number {
    return 1.0 / (1.0 - this.reactivityPcm * 1e-5);
  }
  get shutdownMarginPcm(): number {
    return Math.max(0.0, -this.reactivityPcm);
  }
  get differentialBoronWorthPcmPerPpm(): number {
    return BoronDiffWorth(this.boronPpm) * 1e5;
  }
  /** Beginner easy-startup positive assist, active only at very low power in Startup/Run. */
  get easyStartupAssistActivePcm(): number {
    return this.easyStartupMode &&
      (this.mode === ReactorMode.Startup || this.mode === ReactorMode.Run) &&
      this._power < EasyStartupPowerLimit
      ? EasyStartupAssistPcm
      : 0.0;
  }
  get fuelConsumptionMultiplier(): number {
    return this.easyStartupMode ? EasyStartupBurnFactor : 1.0;
  }

  // ----------------------------------------------------------------- controls ----
  setRodBank(bank: number, percentInserted: number): void {
    if (bank < 0 || bank >= this.rodBankInsertion.length) return;
    this.rodBankInsertion[bank] = clamp(percentInserted, 0, 100);
  }

  setAllRods(percentInserted: number): void {
    for (let b = 0; b < this.rodBankInsertion.length; b++) this.setRodBank(b, percentInserted);
  }

  setMode(m: ReactorMode): void {
    if (this.mode === ReactorMode.Meltdown) return;
    if (m === ReactorMode.Tripped || m === ReactorMode.Meltdown) return;
    this.mode = m;
  }

  startRcp(i: number): void {
    if (i >= 0 && i < 4) this._rcpRunning[i] = true;
  }
  stopRcp(i: number): void {
    if (i >= 0 && i < 4) this._rcpRunning[i] = false;
  }
  private _rcpRunning = [false, false, false, false];
  get rcpRunning(): boolean[] {
    return this._rcpRunning;
  }
  rcpFlowDemand = 0.0; // 0..1 commanded pump flow

  private sumRodWorthFrac(): number {
    let s = 0.0;
    for (let b = 0; b < this.rodBankInsertion.length; b++)
      s += RodWorthFrac[b]! * rodS(this.rodBankInsertion[b]! / 100.0);
    return s;
  }

  rodStepsWithdrawn(bank: number): number {
    if (bank < 0 || bank >= this.rodBankInsertion.length) return 0;
    return Math.round((1.0 - this.rodBankInsertion[bank]! / 100.0) * RodStepsPerBank);
  }

  scram(): void {
    this.isScrammed = true;
    // The reactor trip breakers open and the rods are released to fall under gravity — arm the
    // breaker+gripper release dead-time; StepRodDrop then drives each bank fully seated.
    if (!this._rodsFailToInsert) {
      this._rodReleaseTimer = ROD_RELEASE_DELAY_S;
      this.rodDropElapsedS = 0.0;
      this.rodsDropping = false;
    }
    if (this.mode !== ReactorMode.Meltdown) this.mode = ReactorMode.Tripped;
  }

  /** Auto-scram entry used by the RPS; suppressed by the beginner easy-startup mode. */
  private tryAutoScram(en: string, zh: string): boolean {
    if (this.easyStartupMode) return false;
    this.lastTripFunctionEn = en;
    this.lastTripFunctionZh = zh;
    this.scram();
    return true;
  }

  reset(): void {
    this._power = 1e-6;
    for (let i = 0; i < 6; i++)
      this._precursor[i] = ((this.betaCycleFactor * Beta[i]!) / (PromptLifetime * Lambda[i]!)) * this._power;
    this.reactorPeriodSeconds = 1e9;
    this.reactivityPcm = 0;
    this._powerRate = 0;
    this.fuelTemp = ColdTemp;
    this.tcold = ColdTemp;
    this.thot = ColdTemp;
    this.primaryPressure = 2.5;
    this.pressurizerLevel = NominalPzrLevel;
    this._tpzr = ColdTemp;
    this._prevLevel = NominalPzrLevel;
    this.electricPowerMW = 0;
    this.steamPressure = 0.5;
    this.iodine = 0;
    this.xenon = 0;
    this._pm = 0;
    this._sm = 0;
    this._decayGroup.fill(0);
    this._actinide.fill(0);
    this.decayHeatFraction = 0;
    this._rcpFlow.fill(0);
    this._rcpRunning = [false, false, false, false];
    this.coolantFlowFraction = 0;
    this.pumpedFlowFraction = 0;
    this.naturalCircFraction = 0;
    this.rcpCoasting = false;
    this.onNaturalCirc = false;
    this.boronPpm = NominalBoron;
    this.targetBoronPpm = NominalBoron;
    for (let i = 0; i < this.rodBankInsertion.length; i++) this.rodBankInsertion[i] = 100.0;
    this._rodReleaseTimer = 0;
    this.rodDropElapsedS = 0;
    this.rodsDropping = false;
    this._rodsFailToInsert = false;
    this.rcpFlowDemand = 0;
    this.feedwaterFlow = 0;
    this.damageAccumulation = 0;
    this.isScrammed = false;
    this.meltdownTriggered = false;
    this.burnupMwdPerTonne = 0;
    this.depletionAccel = 1.0;
    this.mode = ReactorMode.Shutdown;
    this.lastTripFunctionEn = '';
    this.lastTripFunctionZh = '';
    this.rodReactivityPcm = 0;
    this.boronReactivityPcm = 0;
    this.dopplerReactivityPcm = 0;
    this.moderatorReactivityPcm = 0;
    this.xenonReactivityPcm = 0;
    this.samariumReactivityPcm = 0;
  }

  /** Force the core to an equilibrium hot-full-power condition (for a "restart at power" demo). */
  seedHotFullPower(): void {
    this._power = 1.0;
    this.fuelTemp = 600.0;
    this.tcold = NominalTavg - 15;
    this.thot = NominalTavg + 15;
    this.primaryPressure = NominalPressure;
    this._tpzr = satTempAt(NominalPressure);
    this.xenon = 1.0;
    this.iodine = 1.0;
    this._sm = 1.0;
    this._pm = 1.0;
    this.decayHeatFraction = 0.065;
    for (let i = 0; i < 6; i++)
      this._precursor[i] = ((this.betaCycleFactor * Beta[i]!) / (PromptLifetime * Lambda[i]!)) * this._power;
    for (let i = 0; i < DecayA.length; i++) this._decayGroup[i] = DecayA[i]!;
    for (let i = 0; i < ActinideA.length; i++) this._actinide[i] = ActinideA[i]!;
    this.decayHeatFraction = clamp(
      this._decayGroup.reduce((a, b) => a + b, 0) + this._actinide.reduce((a, b) => a + b, 0),
      0,
      0.12,
    );
    this.setAllRods(0);
    this._rcpRunning = [true, true, true, true];
    this.rcpFlowDemand = 1.0;
    this.feedwaterFlow = 1.0;
    this.coolantFlowFraction = 1.0;
    this.boronPpm = this.criticalBoronPpm;
    this.targetBoronPpm = this.criticalBoronPpm;
    this.mode = ReactorMode.Run;
  }

  // ----------------------------------------------------------------- main loop ----
  update(dt: number): void {
    if (this.mode === ReactorMode.Meltdown) {
      this.updateDecayHeat(dt);
      this.updateMeltdownPhysics(dt);
      return;
    }

    // Held cold shutdown — the operator must start the reactor up.
    if (this.mode === ReactorMode.Shutdown) {
      this.updateBoron(dt);
      this.updateFlow(dt);
      this.updateDecayHeat(dt);
      this.updateXenon(dt);
      // Neutron power decays to the source level; delayed-neutron precursors die away.
      this._power = this.sourceLevel + Math.max(0, this._power - this.sourceLevel) * Math.max(0, 1 - dt / 3.0);
      if (this._power < this.sourceLevel) this._power = this.sourceLevel;
      for (let i = 0; i < 6; i++) this._precursor[i] = Math.max(0, this._precursor[i]! * (1 - Math.min(1, Lambda[i]! * dt)));
      this._powerRate = 0;
      this.reactivityPcm = -9000;
      this.rodReactivityPcm = -8000;
      this.reactorPeriodSeconds = 1e9;
      // Temps & pressure relax toward cold-shutdown conditions.
      const cool = Math.min(1, dt / 25.0);
      this.fuelTemp += (ColdTemp - this.fuelTemp) * cool;
      this.tcold += (ColdTemp - this.tcold) * cool;
      this.thot += (ColdTemp - this.thot) * cool;
      this.primaryPressure += (2.5 - this.primaryPressure) * Math.min(1, dt / 8.0);
      this.pressurizerLevel += (NominalPzrLevel - this.pressurizerLevel) * Math.min(1, dt / 10.0);
      return;
    }

    // slow process controls that don't need sub-stepping
    this.updateBoron(dt);
    this.updateFlow(dt);
    this.updateDecayHeat(dt);

    // sub-step the kinetics + thermal coupling (50 Hz internal integration)
    const powerBefore = this._power;
    const subDt = 0.02;
    const steps = Math.max(1, Math.round(dt / subDt));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      this.stepRodDrop(h);
      this.stepKineticsAndThermal(h);
    }

    // Power rate-of-change (fraction/s) for the power-range rate trip — lightly smoothed.
    if (dt > 1e-6)
      this._powerRate += ((this._power - powerBefore) / dt - this._powerRate) * Math.min(1.0, dt / 0.5);

    // xenon/iodine evolve slowly; once per tick is fine
    this.updateXenon(dt);

    // secondary heat sink (minimal): steam pressure tracks Tavg-driven boil-off
    this.updateSecondary(dt);

    // reactor protection: auto-SCRAM on out-of-bounds conditions
    this.updateProtection(dt);

    // meltdown accrual
    this.updateDamage(dt);
  }

  private updateDecayHeat(dt: number): void {
    // ANS-5.1 exponential-group model, advanced with the exact discrete recurrence.
    const p = Math.max(this._power, 0.0);
    let frac = 0.0;
    for (let i = 0; i < DecayA.length; i++) {
      const oneMinusE = oneMinusExp(DecayLambda[i]! * dt);
      this._decayGroup[i] = this._decayGroup[i]! * (1.0 - oneMinusE) + DecayA[i]! * p * oneMinusE;
      frac += this._decayGroup[i]!;
    }
    for (let i = 0; i < ActinideA.length; i++) {
      const oneMinusE = oneMinusExp(ActinideLambda[i]! * dt);
      this._actinide[i] = this._actinide[i]! * (1.0 - oneMinusE) + ActinideA[i]! * p * oneMinusE;
      frac += this._actinide[i]!;
    }
    this.decayHeatFraction = clamp(frac, 0.0, 0.12);

    // Burnup accrual across the fuel cycle (MWd/tonneU).
    this.burnupMwdPerTonne +=
      (this.thermalPowerMW * dt) / 86400.0 / CoreTonnesU * Math.max(1.0, this.depletionAccel) * this.fuelConsumptionMultiplier;
  }

  private updateBoron(dt: number): void {
    // Charging/dilution moves boron toward target at a limited rate (ppm/s).
    const rate = 4.0;
    const diff = this.targetBoronPpm - this.boronPpm;
    const step = clamp(diff, -rate * dt, rate * dt);
    this.boronPpm = clamp(this.boronPpm + step, 0, 3000);
  }

  private updateFlow(dt: number): void {
    // forced flow: per-loop, asymmetric (fast spin-up, inertial coastdown)
    const demand = clamp(this.rcpFlowDemand, 0, 1);
    let pumped = 0.0;
    let coasting = false;
    const spinAlpha = 1.0 - Math.exp(-dt / RcpSpinUpTau);
    const coastDen = 1.0 + dt * (0.6931471805599453 / RcpCoastHalf);
    for (let i = 0; i < this._rcpFlow.length; i++) {
      let f = this._rcpFlow[i]!;
      if (this._rcpRunning[i]) {
        f += (RcpLoopShare * demand - f) * spinAlpha;
      } else {
        f /= coastDen;
        if (f > 0.01) coasting = true;
      }
      if (f < 0) f = 0;
      this._rcpFlow[i] = f;
      pumped += f;
    }

    // natural-circulation floor: buoyancy thermosiphon, W ∝ Q^(1/3)
    const powerFrac = Math.max(this._power, 0.0) + this.decayHeatFraction;
    const headGate = clamp((this.thot - this.tcold - NatCircDtMin) / NatCircHeadSpan, 0, 1);
    const sinkGate = clamp((this.tavg - this.secondarySatTemp()) / NatCircSinkSpan, 0, 1);
    const hot = this.thot > 100.0 ? 1.0 : 0.0;
    const natural = Math.min(NatCircMax, NatCircCoef * Math.cbrt(powerFrac) * headGate * sinkGate * hot);

    this.pumpedFlowFraction = clamp(pumped, 0, 1);
    this.naturalCircFraction = natural;
    this.rcpCoasting = coasting;
    this.onNaturalCirc = natural > 0 && natural >= pumped;
    this.coolantFlowFraction = clamp(Math.max(pumped, natural), 0, 1);
  }

  private stepRodDrop(h: number): void {
    if (!this.isScrammed || this._rodsFailToInsert) {
      this.rodsDropping = false;
      return;
    }
    this.rodDropElapsedS += h;
    if (this._rodReleaseTimer > 0.0) {
      this._rodReleaseTimer = Math.max(0.0, this._rodReleaseTimer - h);
      this.rodsDropping = false;
      return;
    }
    let anyMoving = false;
    for (let b = 0; b < this.rodBankInsertion.length; b++) {
      const p = this.rodBankInsertion[b]! / 100.0;
      if (p >= 1.0) continue;
      const np = this.advanceRodDrop(p, h);
      this.rodBankInsertion[b] = np * 100.0;
      if (np < 1.0) anyMoving = true;
    }
    this.rodsDropping = anyMoving;
  }

  private advanceRodDrop(p: number, h: number): number {
    let v: number;
    if (p < RodDropDashpotEntry) {
      v = RodDropFreeFallVel; // drag-limited terminal velocity
    } else {
      const f = (p - RodDropDashpotEntry) / (1.0 - RodDropDashpotEntry);
      v = RodDropFreeFallVel * (RodDropDashpotVelFac + (1.0 - RodDropDashpotVelFac) * (1.0 - f));
      if (v < 0.02) v = 0.02;
    }
    return Math.min(1.0, p + v * h);
  }

  private stepKineticsAndThermal(h: number): void {
    // ---- compute reactivity ----
    const rodRho = -TotalRodWorth * this.sumRodWorthFrac();
    const boronRho = BoronRhoTotal(this.boronPpm);
    const dopplerRho = DopplerCoeff * (this.fuelTemp - RefFuelTemp);
    const effMtc = ModTempCoeff + MtcEolSlope * this.cycleFraction;
    const modRho = effMtc * (this.tavg - RefModTemp);
    const xenonRho = XenonWorthFull * this.xenon;
    const samariumRho = SamariumWorthFull * this._sm;

    // Fresh-core excess baseline: nominal boron with rods withdrawn is near critical.
    const excessBaseline = -BoronRhoTotal(NominalBoron);
    // Fuel-depletion (burnup) reactivity defect (zero at BOL, −1130 pcm at EOL).
    const burnupDefectRho = BoronRhoTotal(NominalBoron) - BoronRhoTotal(this.criticalBoronPpm);
    const startupAssistRho = this.easyStartupAssistActivePcm * 1e-5;

    const rho =
      excessBaseline + rodRho + boronRho + dopplerRho + modRho + xenonRho + samariumRho + burnupDefectRho + startupAssistRho;
    const bcf = this.betaCycleFactor;

    // ---- point kinetics (6 groups), unconditionally-stable backward (implicit) Euler ----
    let precursorContribution = 0;
    let implicitFeedback = 0;
    for (let i = 0; i < 6; i++) {
      const di = 1.0 + h * Lambda[i];
      precursorContribution += (Lambda[i] * this._precursor[i]) / di;
      implicitFeedback += (h * Lambda[i] * (Beta[i] * bcf)) / (PromptLifetime * di);
    }

    let denom = 1.0 - (h * (rho - BetaTotal * bcf)) / PromptLifetime - h * implicitFeedback;
    if (denom < 1e-3) denom = 1e-3; // backstop: denom crosses zero at/above prompt-critical

    let newPower = (this._power + h * (precursorContribution + this.sourceLevel)) / denom;
    if (newPower < 1e-12) newPower = 1e-12;

    for (let i = 0; i < 6; i++) {
      this._precursor[i] =
        (this._precursor[i] + h * ((Beta[i] * bcf) / PromptLifetime) * newPower) / (1.0 + h * Lambda[i]);
      if (this._precursor[i] < 0) this._precursor[i] = 0;
    }

    const rate = (newPower - this._power) / (Math.max(this._power, 1e-12) * h);
    this.reactorPeriodSeconds = Math.abs(rate) < 1e-9 ? 1e9 : 1.0 / rate;
    this._power = newPower;
    if (this._power > 50) this._power = 50; // numerical backstop only

    // reactivity breakdown for display (pcm)
    this.rodReactivityPcm = rodRho * 1e5;
    this.boronReactivityPcm = (boronRho + excessBaseline) * 1e5; // fold baseline into boron line
    this.dopplerReactivityPcm = dopplerRho * 1e5;
    this.moderatorReactivityPcm = modRho * 1e5;
    this.xenonReactivityPcm = xenonRho * 1e5;
    this.samariumReactivityPcm = samariumRho * 1e5;
    this.reactivityPcm = rho * 1e5;

    // ---- thermal-hydraulics (lumped) ----
    this.stepThermal(h);
  }

  private stepThermal(h: number): void {
    // Fuel heats from fission power PLUS decay heat (present even after SCRAM).
    const q = (this._power + this.decayHeatFraction) * RatedThermalMW; // MW generated in fuel
    const fuelToCoolant = 0.06 * (this.fuelTemp - this.tavg); // MW per °C (lumped)
    const fuelHeatCap = 35.0; // MW·s per °C
    this.fuelTemp += ((q - fuelToCoolant) / fuelHeatCap) * h;
    if (this.fuelTemp < ColdTemp) this.fuelTemp = ColdTemp;

    // Coolant: receives fuelToCoolant, rejects heat to SG proportional to flow & secondary delta.
    let sgRemoval = (8.0 + 90.0 * this.coolantFlowFraction) * Math.max(0, this.tavg - this.secondarySatTemp()) * 0.01;
    sgRemoval *= 0.3 + 0.7 * this.feedwaterFlow; // feedwater enables heat sink
    const coolantHeatCap = 60.0; // MW·s per °C
    const netCoolant = fuelToCoolant - sgRemoval;
    const avg = this.tavg + (netCoolant / coolantHeatCap) * h;

    // Flow sets the Thot-Tcold spread for a given power: deltaT ~ power / flow.
    const flow = Math.max(this.coolantFlowFraction, 0.02);
    const deltaT = clamp((35.0 * this._power) / flow, 0, 120);
    this.tcold = avg - deltaT / 2.0;
    this.thot = avg + deltaT / 2.0;
    if (this.tcold < ColdTemp) this.tcold = ColdTemp;

    // pressurizer water level: programmed to Tavg (insurge/outsurge swell)
    const lvlTarget = NominalPzrLevel + (avg - NominalTavg) * 0.3;
    this.pressurizerLevel += (lvlTarget - this.pressurizerLevel) * Math.min(1, h / 8.0);
    this.pressurizerLevel = clamp(this.pressurizerLevel, 0, 100);

    // primary pressure via a saturated-pressurizer model: heaters drive the pzr liquid temperature,
    // and P follows Psat(_tpzr). Heaters energize automatically once the core is hot.
    const dLevelDt = clamp((this.pressurizerLevel - this._prevLevel) / Math.max(h, 1e-6), -20.0, 20.0);
    this._prevLevel = this.pressurizerLevel;
    // Auto pressure-control program: proportional heaters + spray to hold ~15.5 MPa.
    const heaterDuty = clamp((NominalPressure - this.primaryPressure) / 0.2, 0, 1);
    const sprayFrac = clamp((this.primaryPressure - 15.68) / (16.03 - 15.68), 0, 1);
    const qHeater = 1.8 * heaterDuty;
    const qSpray = 0.06 * sprayFrac * Math.max(0, this._tpzr - this.tcold);
    const qSurge = dLevelDt > 0 ? 0.4 * dLevelDt * Math.max(0, avg - this._tpzr) : 0.0;
    const qLoss = 0.003 * (this._tpzr - 50.0);
    this._tpzr += ((qHeater - qSpray + qSurge - qLoss) / 15.0) * h;
    this._tpzr = clamp(this._tpzr, 80.0, 360.0);
    const pTarget = Math.max(satPressAt(this._tpzr), 2.5);
    this.primaryPressure += (pTarget - this.primaryPressure) * Math.min(1, h / 2.0);
    this.primaryPressure = clamp(this.primaryPressure, 0.1, VesselBurstPressure);
  }

  private secondarySatTemp(): number {
    return 100.0 + 26.8 * Math.pow(Math.max(this.steamPressure, 0.05), 0.5) + this.steamPressure * 8.0;
  }

  private updateSecondary(dt: number): void {
    // Steam pressure tracks a Tavg-driven boil-off target; electrical output follows thermal power.
    const target = clamp(0.5 + 6.4 * clamp(this._power, 0, 1), 0.5, 7.2);
    this.steamPressure += (target - this.steamPressure) * Math.min(1, dt / 6.0);
    const grossElec = this._power * RatedElectricMW * (this.feedwaterFlow > 0.1 ? 1.0 : 0.0);
    this.electricPowerMW += (grossElec - this.electricPowerMW) * Math.min(1, dt / 4.0);
  }

  private updateXenon(dt: number): void {
    // I-135 -> Xe-135 -> (decay + burnup). Normalized so equilibrium full power gives Xenon≈1.
    const lamI = 2.9e-5; // 1/s (I-135, ~6.6 h)
    const lamX = 2.1e-5; // 1/s (Xe-135, ~9.2 h)
    const gammaX = 0.06; // direct xenon yield scaling
    const sigmaPhi = 7.0e-5; // burnup rate * flux scaling (per s at full power)

    const phi = this._power; // proportional to flux
    const prodI = 0.95 * phi;
    this.iodine += (prodI * lamI - lamI * this.iodine) * dt;
    if (this.iodine < 0) this.iodine = 0;

    const prodX = lamI * this.iodine + gammaX * phi;
    const burn = (sigmaPhi * phi * this.xenon) / 7.0e-5;
    const dX = prodX - lamX * this.xenon - burn;
    this.xenon += dX * dt;
    if (this.xenon < 0) this.xenon = 0;

    // Sm-149 / Pm-149 second poison pair. Normalized so equilibrium full power gives Samarium≈1.
    const lamPm = 3.626e-6; // 1/s, Pm-149 decay (ln2 / 53.1 h)
    const sigmaSm = 6.6613e-6; // 1/s, Sm-149 burnout at full power
    const gammaPm = 1.8371; // = sigmaSm/lamPm, so equilibrium Samarium normalizes to 1
    this._pm += (gammaPm * lamPm * phi - lamPm * this._pm) * dt;
    if (this._pm < 0) this._pm = 0;
    this._sm += (lamPm * this._pm - sigmaSm * phi * this._sm) * dt;
    if (this._sm < 0) this._sm = 0;
  }

  get samarium(): number {
    return this._sm;
  }

  /** Trigger the post-trip iodine-pit xenon peak (XenonRestart scenario). */
  triggerXenonRestart(): void {
    // Seed a post-trip equilibrium: high iodine inventory that will decay into a xenon peak.
    this.xenon = 2.8;
    this.iodine = 1.0;
  }

  private updateProtection(dt: number): void {
    if (this.isScrammed) return;
    // High neutron flux (power-range) trip @118% RTP.
    if (this._power >= HighPowerTrip) {
      this.tryAutoScram('Power Range High Flux', '功率量程高中子通量');
      return;
    }
    // Short reactor period (startup-rate) trip.
    if (this.reactorPeriodSeconds > 0 && this.reactorPeriodSeconds < ShortPeriodTrip && this._power > 1e-4) {
      this.tryAutoScram('Short Reactor Period', '反應堆週期過短');
      return;
    }
    // High hot-leg temperature.
    if (this.thot >= HighThotTrip) {
      this.tryAutoScram('Hot-Leg Temperature High', '熱管溫度高');
      return;
    }
    // High primary pressure.
    if (this.primaryPressure >= VesselPressureLimit) {
      this.tryAutoScram('Pressurizer Pressure High', '穩壓器壓力高');
      return;
    }
    // Low coolant flow while at power.
    if (this._power > 0.1 && this.coolantFlowFraction < LowFlowTrip) {
      this.tryAutoScram('Reactor Coolant Flow Low', '反應堆冷卻劑流量低');
      return;
    }
  }

  private updateDamage(dt: number): void {
    // Sustained over-temperature / over-pressure accrues core damage → meltdown.
    let dmgRate = 0;
    if (this.fuelTemp > FuelDamageTemp) dmgRate += (this.fuelTemp - FuelDamageTemp) / 100.0;
    if (this.primaryPressure > VesselPressureLimit) dmgRate += (this.primaryPressure - VesselPressureLimit) * 2.0;
    if (dmgRate > 0) this.damageAccumulation += dmgRate * dt;
    else this.damageAccumulation = Math.max(0, this.damageAccumulation - dt * 0.5); // slow healing below limits
    if (this.damageAccumulation >= MeltdownDamageThreshold && !this.meltdownTriggered) {
      this.meltdownTriggered = true;
      this.mode = ReactorMode.Meltdown;
    }
  }

  private updateMeltdownPhysics(dt: number): void {
    // Core damaged: decay heat with no effective sink drives fuel temperature toward melt.
    const q = this.decayHeatFraction * RatedThermalMW;
    this.fuelTemp += ((q - 0.02 * (this.fuelTemp - this.tavg)) / 35.0) * dt;
    this.fuelTemp = clamp(this.fuelTemp, ColdTemp, FuelMeltTemp + 200);
  }

  // ----------------------------------------------------------------- snapshot ----
  state(): ReactorState {
    return {
      mode: this.mode,
      neutronPowerFraction: this._power,
      coreThermalPowerFraction: this.coreThermalPowerFraction,
      thermalPowerMW: this.thermalPowerMW,
      electricPowerMW: this.electricPowerMW,
      reactivityPcm: this.reactivityPcm,
      reactivity: {
        rod: this.rodReactivityPcm,
        boron: this.boronReactivityPcm,
        doppler: this.dopplerReactivityPcm,
        moderator: this.moderatorReactivityPcm,
        xenon: this.xenonReactivityPcm,
        samarium: this.samariumReactivityPcm,
      },
      reactorPeriodSeconds: this.reactorPeriodSeconds,
      fuelTemp: this.fuelTemp,
      tavg: this.tavg,
      tcold: this.tcold,
      thot: this.thot,
      primaryPressure: this.primaryPressure,
      pressurizerLevel: this.pressurizerLevel,
      coolantFlowFraction: this.coolantFlowFraction,
      boronPpm: this.boronPpm,
      targetBoronPpm: this.targetBoronPpm,
      rodBankInsertion: [...this.rodBankInsertion],
      decayHeatFraction: this.decayHeatFraction,
      xenon: this.xenon,
      iodine: this.iodine,
      samarium: this._sm,
      burnupMwdPerTonne: this.burnupMwdPerTonne,
      cycleFraction: this.cycleFraction,
      coreLifePhase: this.coreLifePhase,
      criticalBoronPpm: this.criticalBoronPpm,
      isScrammed: this.isScrammed,
      rodsDropping: this.rodsDropping,
      keff: this.coreKeff,
      shutdownMarginPcm: this.shutdownMarginPcm,
      lastTripEn: this.lastTripFunctionEn,
      lastTripZh: this.lastTripFunctionZh,
    };
  }
}

export { clamp as _clamp, isFiniteNum as _isFiniteNum, satPressAt as _satPressAt };
