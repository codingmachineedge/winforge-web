// 穩壓器釋壓系統 · Pressurizer pressure-relief system — PORV + block valve + 3 ASME code safety
// valves + Pressurizer Relief Tank (PRT / quench tank) + the stuck-open-PORV (TMI-2) scenario.
//
// A pure, deterministic, framework-free TypeScript port of the relief block of WinForge's C#
// `ReactorSimService` (Services/ReactorSimService.cs):
//   • PORV auto latch (open 2335 psig / reseat 2315 psig, LTOP re-ranged when armed) — source L4697–4707
//   • 3 staggered ASME Section III code safeties, pop-action latch + blowdown hysteresis and a
//     proportional lift between pop and +3% accumulation — source L4709–4735
//   • PRT lumped first-law pool + N₂ cover gas + Buck vapour pressure + rupture disc + post-burst
//     containment blowdown — source UpdatePrt L3969–4024
//   • The stuck-open PORV drill and the block-valve isolation (the TMI-2 recovery action). The C#
//     source does not carry these yet — they are modelled here per the TMI-2 sequence: the valve
//     fails to reseat (or sticks immediately if already open) and only the motor-operated block
//     valve upstream can terminate the discharge.
//
// The module NEVER mutates the reactor sim. It consumes the primary pressure, walks its own
// latches on an internal working copy (sub-stepped at ≤0.02 s to reproduce the C# 50 Hz
// sequential PORV-before-safeties evaluation), and returns the total depressurization rate for the
// integrator to apply. The PRT side is one-way coupled exactly like the C# (it never writes RCS
// pressure); only a burst rupture disc produces a containment-pressure drive.

import { _clamp, VesselBurstPressure } from './physics';

// ------------------------------------------------------------------ constants ----
// Pressurizer pressure-control relief setpoints (Westinghouse 4-loop, psig → MPa-abs).
const PorvOpenPressure = 16.2; // 2335 psig — power-operated relief valve opens (source L462)
const PorvClosePressure = 16.06; // 2315 psig — PORV reseats (source L463)
const PorvReliefRate = 2.5; // MPa/s PORV blowdown rate while lifted (source L474)

// Pressurizer ASME Section III code (spring) safety valves — three self-actuated valves ABOVE the
// PORV, the last-ditch RCS overpressure protection. Standard set 2485 psig (≈2500 psia, the RCS
// design pressure); MPa_abs = (psig + 14.7) / 145.038. Staggered within ±1% as-found tolerance so
// they don't all pop on the same simulation step; full lift at +3% accumulation (2560 psig);
// blowdown ~5% below each valve's own set gives the open-vs-reseat hysteresis that prevents
// chatter. Every reseat point stays above PORV-close (16.06) so the safeties and PORV never fight.
const PzrSafety1Set = 17.18; // 2477 psig (−0.3% tol) — code safety #1 lift (source L483)
const PzrSafety2Set = 17.24; // 2485 psig (nominal)   — code safety #2 lift (source L484)
const PzrSafety3Set = 17.3; // 2494 psig (+0.4% tol)  — code safety #3 lift (source L485)
const PzrSafetyAccum = 17.75; // 2560 psig (+3% accumulation) — pressure at full lift (source L486)
const PzrSafetyBlowdown = 0.86; // MPa (~5% of set) — open→reseat hysteresis band (source L487)
const PzrSafetyReliefRate = 4.0; // MPa/s per valve at full lift (> PORV capacity) (source L488)
const PzrSafetySet = new Float64Array([PzrSafety1Set, PzrSafety2Set, PzrSafety3Set]); // source L489

// LTOP / COMS — while armed (cold RCS) the PORVs are re-ranged to a low cold setpoint so they
// relieve well below the Appendix-G brittle-fracture limit. effClose < effOpen by construction.
const LtopOpenPressureMPa = 3.1; // MPa-abs (~435 psig) LTOP PORV lift setpoint while armed (source L551)
const LtopCloseHystMPa = 0.21; // MPa (~30 psi) blowdown → reseat at 2.89 MPa (source L552)

// ---- Pressurizer Relief Tank (PRT) / quench tank — collects PORV + code-safety discharge ----
// 穩壓器釋壓缸 · A subcooled water pool under a nitrogen cover gas condenses the discharged steam;
// the pool warms and the gas space compresses, so PRT temperature/pressure/level RISE whenever a
// relief path is open — the classic diagnostic that a PORV or safety is leaking or stuck open
// (the TMI-2, 1979 lesson: a valve-OPEN command light is not valve-POSITION; the rising-hot PRT
// was the real cue the PORV had stuck open). Westinghouse 4-loop figures (≈1800 ft³ tank).
const PrtTankVolumeM3 = 51.0; // m³ (~1800 ft³) total gas+liquid control volume (source L502)
const PrtWaterMass0Kg = 33000.0; // kg normal water inventory (~65% full) (source L503)
const PrtWaterTemp0K = 322.0; // K normal pool temperature (120 °F / 49 °C) (source L504)
const PrtN2Pressure0Pa = 1.2e5; // Pa-abs N₂ cover-gas blanket (~3 psig) (source L505)
const PrtN2GasConst = 296.8; // J/(kg·K) R for nitrogen (8314/28.0134) (source L506)
const PrtWaterCp = 4186.0; // J/(kg·K) liquid-water specific heat (source L507)
const PrtSteamEnthalpy = 2.595e6; // J/kg sat-steam enthalpy at the relief setpoint ~16.2 MPa (source L508)
const PrtKMdotKgPerMPas = 12.0; // kg per (MPa/s) relief rate → ~30 kg/s for a stuck-open PORV (source L509)
const PrtDiscBurstPsig = 100.0; // psig rupture-disc burst setpoint (W 4-loop UFSAR) (source L510)
const PrtAlarmPressPsig = 8.0; // psig high-pressure annunciator (source L511)
const PrtAlarmTempC = 60.0; // °C high-temperature annunciator (source L512)
const PrtAlarmLevelHiPct = 92.0; // % high-level annunciator (source L513)
const PrtAlarmLevelLoPct = 50.0; // % low-level annunciator (source L514)
const PrtVentKpaPerKgs = 0.9; // kPa containment-pressure drive per kg/s of post-burst venting (source L515)
const PrtVentKgsPerMPa = 18.0; // kg/s vented per MPa of PRT-over-containment Δp after burst (source L516)
const PrtAtmPa = 101325.0; // Pa standard atmosphere (gauge↔abs conversion) (source L517)
const PrtPsigDivisor = 6894.76; // Pa per psi as used by the C# readout conversion (source L4002)

const SubStepMaxS = 0.02; // s — internal sub-step matching the C# 50 Hz inner step (`subDt = 0.02`, source L3032)
const PressureFloorMPa = 0.1; // MPa — C# clamps PrimaryPressure to [0.1, VesselBurstPressure] (source L4738)

// ------------------------------------------------------------------ interfaces ----

/** Values the integrator reads FROM the reactor sim each tick and hands to `step`. */
export interface PressureReliefInputs {
  /** RCS primary pressure, MPa-abs (sim.primaryPressure). */
  primaryPressureMPa: number;
  /**
   * LTOP/COMS armed (cold RCS — sim's Appendix-G block sets this below the 135 °C enable temp).
   * Safe default `false` until the P/T-limits module exists in the TS port. While armed the PORV
   * lifts at the LTOP low setpoint 3.10 MPa and reseats 0.21 MPa lower (source L543–552).
   */
  ltopArmed: boolean;
  /**
   * Containment pressure, kPa-gauge (sim.containmentPressureKpa) — back-pressure for the
   * post-burst PRT blowdown (source L4011). Safe default 0 until containment is ported.
   */
  containmentPressureKpa?: number;
  /** Reactor scrammed (reserved for display/drill bookkeeping — the C# relief logic is pressure-only). */
  scrammed?: boolean;
}

/** Effects the integrator applies back to the sim after `step`. */
export interface PressureReliefOutputs {
  /**
   * Total primary depressurization from every open relief path this step, MPa/s (≥ 0).
   * Integrator: primaryPressure -= reliefRateMPaPerS * dt (already capped so pressure cannot be
   * pulled below the 0.1 MPa floor within this step).
   */
  reliefRateMPaPerS: number;
  /** PORV actually passing flow at end of step (auto-open or stuck, and block valve open). */
  porvOpen: boolean;
  /** PORV mechanically stuck open (TMI-2 failure latched). */
  porvStuckOpen: boolean;
  /** Motor-operated block valve upstream of the PORV is closed (isolates a stuck PORV). */
  blockValveClosed: boolean;
  /** How many of the 3 code safety valves are currently popped (0–3). */
  safetiesOpen: number;
  /** LTOP-armed low-setpoint PORV path actively relieving (source L4706 semantics + block valve). */
  ltopPorvOpen: boolean;
  /** Post-burst containment-pressure drive, kPa per tick-second (0 until the rupture disc bursts). */
  prtVentDriveKpa: number;
  /** A relief path discharged into the PRT this step (sparger flow > 0.05 kg/s) (source L3982). */
  discharging: boolean;
}

/** Plain JSON-serializable display snapshot for the panel. */
export interface PressureReliefView {
  // ---- valve lamps ----
  /** The PORV COMMAND latch (the TMI-2 lamp: demand, not position). */
  porvCommandOpen: boolean;
  /** The PORV actually passing flow (position, incl. stuck-open, gated by the block valve). */
  porvFlowOpen: boolean;
  porvStuckOpen: boolean;
  /** Stuck-PORV drill armed but not yet failed (waiting for the next reseat). */
  porvStuckPending: boolean;
  blockValveClosed: boolean;
  /** Per-valve latched lift state of the 3 code safeties. */
  safetyOpen: boolean[];
  safetiesOpen: number;
  ltopArmed: boolean;
  ltopPorvOpen: boolean;
  /** Total relief depressurization rate applied last step, MPa/s. */
  reliefRateMPaPerS: number;
  // ---- PRT readouts ----
  prtPressurePsig: number;
  prtTempC: number;
  prtTempF: number;
  prtLevelPct: number;
  ruptureDiscBurst: boolean;
  discharging: boolean;
  prtVentDriveKpa: number;
  // ---- annunciators (bilingual parallel arrays, like physics activeAlarmsEn/Zh) ----
  alarmsEn: string[];
  alarmsZh: string[];
  // ---- one-line PORV status for the panel (dynamic physics string, En/Zh pair) ----
  porvStatusEn: string;
  porvStatusZh: string;
}

// ------------------------------------------------------------------ the system ----

/**
 * 穩壓器釋壓系統 · Pressurizer relief system. `step` is called once per outer sim tick with the
 * SIMULATED dt (typically 0.2–2 s); it sub-steps internally at ≤0.02 s so the PORV-before-safeties
 * sequential evaluation and the latch hysteresis behave identically to the C# 50 Hz inner step.
 */
export class PressureReliefSystem {
  // ---- valve latches ----
  private _porvAuto = false; // automatic PORV command latch currently lifted (source L793)
  private _porvStuck = false; // valve mechanically failed open (TMI-2) — cleared only by reset()
  private _stickPending = false; // drill armed: fail open on the NEXT reseat
  private _blockClosed = false; // motor-operated block valve upstream of the PORV
  private _safetyOpen: boolean[] = [false, false, false]; // latched per-valve lift (source L794)
  private _ltopArmed = false; // mirrored from inputs for the view
  private _ltopPorvOpen = false; // LTOP path actively relieving (source L845)

  // ---- PRT state (source L888–905) ----
  private _prtWaterKg = PrtWaterMass0Kg; // pool mass (kg)
  private _prtWaterTempK = PrtWaterTemp0K; // pool temperature (K)
  private _prtN2Kg: number; // fixed N₂ cover-gas mass (kg), derived from the normal cold state
  private _prtPressurePa = PrtN2Pressure0Pa; // current total tank pressure (Pa-abs)
  private _prtPressurePsig = (PrtN2Pressure0Pa - PrtAtmPa) / PrtPsigDivisor;
  private _prtLevelPct = (100.0 * PrtWaterMass0Kg) / (1000.0 * PrtTankVolumeM3); // source L901
  private _prtDiscBurst = false; // latching, non-reclosing (source L903)
  private _prtDischarging = false;
  private _prtVentDriveKpa = 0;

  private _lastReliefRate = 0; // MPa/s applied last step (display)

  constructor() {
    // One-time derivation of the fixed cover-gas mass from the normal cold gas-space state
    // (source L3972–3976) — done eagerly here so the model is deterministic from construction.
    this._prtN2Kg = PressureReliefSystem.initialN2Kg();
  }

  private static initialN2Kg(): number {
    const vg0 = Math.max(PrtTankVolumeM3 - PrtWaterMass0Kg / 1000.0, 0.01);
    return (PrtN2Pressure0Pa * vg0) / (PrtN2GasConst * PrtWaterTemp0K);
  }

  // ------------------------------------------------------------- operator controls ----

  /**
   * 卡閥演習 · Stuck-open-PORV (TMI-2) drill: the PORV sticks open on its next reseat, or
   * immediately if it is open right now. Cleared only by reset().
   */
  triggerStuckPorv(): void {
    if (this._porvAuto) this._porvStuck = true;
    else this._stickPending = true;
  }

  /** 關隔離閥 · Close the PORV block valve — the TMI-2 recovery action that isolates a stuck PORV. */
  closeBlockValve(): void {
    this._blockClosed = true;
  }

  /** 開隔離閥 · Reopen the PORV block valve (re-admits flow to a still-stuck PORV). */
  openBlockValve(): void {
    this._blockClosed = false;
  }

  /** Reset all latches and the PRT to the normal cold state (mirrors source L2808–2820). */
  reset(): void {
    this._porvAuto = false;
    this._porvStuck = false;
    this._stickPending = false;
    this._blockClosed = false;
    this._safetyOpen = [false, false, false]; // re-seat all code safeties (source L2809)
    this._ltopArmed = false;
    this._ltopPorvOpen = false;
    this._prtWaterKg = PrtWaterMass0Kg;
    this._prtWaterTempK = PrtWaterTemp0K;
    this._prtN2Kg = PressureReliefSystem.initialN2Kg();
    this._prtPressurePa = PrtN2Pressure0Pa; // source L2815
    this._prtPressurePsig = (PrtN2Pressure0Pa - PrtAtmPa) / PrtPsigDivisor;
    this._prtLevelPct = (100.0 * PrtWaterMass0Kg) / (1000.0 * PrtTankVolumeM3);
    this._prtDiscBurst = false;
    this._prtDischarging = false;
    this._prtVentDriveKpa = 0;
    this._lastReliefRate = 0;
  }

  // ------------------------------------------------------------------------- step ----

  step(inp: PressureReliefInputs, dt: number): PressureReliefOutputs {
    if (!(dt > 0)) {
      return this.outputs(0);
    }
    this._ltopArmed = inp.ltopArmed;

    // Effective PORV setpoints — LTOP re-ranges the valve while armed (source L4702–4703).
    const effOpen = inp.ltopArmed ? LtopOpenPressureMPa : PorvOpenPressure;
    const effClose = inp.ltopArmed ? LtopOpenPressureMPa - LtopCloseHystMPa : PorvClosePressure;

    // Walk the valve latches on an internal working pressure, sub-stepped at ≤0.02 s so the
    // C# 50 Hz sequential PORV-then-safeties evaluation is reproduced at any outer dt.
    let p = _clamp(inp.primaryPressureMPa, PressureFloorMPa, VesselBurstPressure);
    const p0 = p;
    const n = Math.max(1, Math.ceil(dt / SubStepMaxS));
    const h = dt / n;
    let reliefAccumMPa = 0; // discharge into the PRT this tick (≡ _prtReliefAccumMPa, source L891)

    for (let s = 0; s < n; s++) {
      // --- PORV command latch: opens at effOpen, reseats at effClose (source L4704–4705) ---
      if (p > effOpen) {
        this._porvAuto = true;
      } else if (p < effClose) {
        if (this._porvAuto && this._stickPending) {
          // The drill fires exactly at the moment the valve should reseat — TMI-2 sequence.
          this._porvStuck = true;
          this._stickPending = false;
        }
        this._porvAuto = false;
      }
      // The valve passes flow if commanded open OR mechanically stuck, and the upstream
      // motor-operated block valve is open (the TMI recovery isolation).
      const porvFlow = (this._porvAuto || this._porvStuck) && !this._blockClosed;
      if (porvFlow) {
        const drop = Math.min(PorvReliefRate * h, Math.max(0, p - PressureFloorMPa));
        p -= drop;
        reliefAccumMPa += drop; // source L4707: relief decrement sparges into the PRT
      }

      // --- ASME code safeties: pop-action latch + blowdown hysteresis (source L4713–4726) ---
      let lowestLiftedSeat = Number.MAX_VALUE;
      for (let i = 0; i < 3; i++) {
        if (!this._safetyOpen[i]! && p > PzrSafetySet[i]!) {
          this._safetyOpen[i] = true; // rising edge — pops individually
        } else if (this._safetyOpen[i]! && p < PzrSafetySet[i]! - PzrSafetyBlowdown) {
          this._safetyOpen[i] = false; // reseat only after full blowdown
        }
        if (this._safetyOpen[i]! && PzrSafetySet[i]! < lowestLiftedSeat) lowestLiftedSeat = PzrSafetySet[i]!;
      }
      const safetiesOpen = this.safetiesOpenCount();
      if (safetiesOpen > 0) {
        // Proportional lift between pop and full accumulation (choked-flow surrogate, source L4730).
        const liftFrac = _clamp((p - lowestLiftedSeat) / (PzrSafetyAccum - lowestLiftedSeat), 0, 1);
        let safetyDrop = safetiesOpen * PzrSafetyReliefRate * liftFrac * h;
        safetyDrop = Math.min(safetyDrop, Math.max(0, p - PressureFloorMPa)); // never overshoot the floor (source L4732)
        p -= safetyDrop;
        reliefAccumMPa += safetyDrop; // the code-safety discharge also sparges into the PRT (source L4734)
      }
    }

    // LTOP relieving indication (source L4706) — with the block valve modelled, "relieving"
    // means actual flow, so the block-valve gate is included.
    this._ltopPorvOpen = inp.ltopArmed && (this._porvAuto || this._porvStuck) && !this._blockClosed;

    // --- PRT mass/energy balance, once per outer tick with the accumulated relief (UpdatePrt) ---
    this.updatePrt(reliefAccumMPa, dt, inp.containmentPressureKpa ?? 0);

    this._lastReliefRate = (p0 - p) / dt;
    return this.outputs(this._lastReliefRate);
  }

  /** 釋壓缸 · PRT lumped model — straight port of UpdatePrt (source L3969–4024). */
  private updatePrt(reliefMPa: number, dt: number, containmentPressureKpa: number): void {
    // Discharged-steam mass from the accumulated relief decrement (≈30 kg/s for a stuck-open PORV).
    const mdotIn = Math.max(0, (reliefMPa / dt) * PrtKMdotKgPerMPas); // kg/s (source L3981)
    this._prtDischarging = mdotIn > 0.05; // source L3982

    // Water pool: first-law open-system mass + energy (incoming enthalpy minus the pool's own).
    const tPoolC = this._prtWaterTempK - 273.15;
    this._prtWaterKg += mdotIn * dt;
    this._prtWaterTempK +=
      ((mdotIn * (PrtSteamEnthalpy - PrtWaterCp * tPoolC)) / (this._prtWaterKg * PrtWaterCp)) * dt;
    this._prtWaterTempK = _clamp(this._prtWaterTempK, 273.15, 470.0); // source L3988

    // Geometry / N₂ partial pressure (ideal gas, fixed mass, isothermal with the pool).
    const rhoW = _clamp(1000.0 - 0.45 * (this._prtWaterTempK - 277.0), 850.0, 1000.0); // source L3991
    const vW = this._prtWaterKg / rhoW;
    const vG = Math.max(PrtTankVolumeM3 - vW, 0.01 * PrtTankVolumeM3);
    const pN2 = (this._prtN2Kg * PrtN2GasConst * this._prtWaterTempK) / vG;

    // Water-vapour partial pressure of the warming pool (Buck equation, °C) — source L3997–3999.
    const tc = this._prtWaterTempK - 273.15;
    let pSat = 611.21 * Math.exp((18.678 - tc / 234.5) * (tc / (257.14 + tc)));
    pSat = _clamp(pSat, 0.0, 2.0e6);

    this._prtPressurePa = pN2 + pSat;
    this._prtPressurePsig = (this._prtPressurePa - PrtAtmPa) / PrtPsigDivisor; // source L4002
    this._prtLevelPct = _clamp((100.0 * vW) / PrtTankVolumeM3, 0.0, 100.0);

    // Rupture disc: latching, non-reclosing; bursts on PRT high pressure (source L4006–4007).
    if (!this._prtDiscBurst && this._prtPressurePsig > PrtDiscBurstPsig) this._prtDiscBurst = true;

    if (this._prtDiscBurst) {
      // Post-burst blowdown toward containment (source L4009–4019).
      const pContPa = containmentPressureKpa * 1000.0 + PrtAtmPa; // containment absolute
      const dpMPa = Math.max(0.0, (this._prtPressurePa - pContPa) / 1.0e6);
      const mdotVent = PrtVentKgsPerMPa * dpMPa; // kg/s, linear in over-pressure
      const vented = Math.min(mdotVent * dt, this._prtWaterKg);
      this._prtWaterKg -= vented;
      // Bleed the cover gas in proportion so the tank relaxes toward the containment back-pressure.
      this._prtN2Kg = Math.max(0.0, this._prtN2Kg - this._prtN2Kg * (vented / (this._prtWaterKg + 1.0)));
      this._prtVentDriveKpa = PrtVentKpaPerKgs * mdotVent; // containment-pressure drive (source L4018)
    } else {
      this._prtVentDriveKpa = 0.0;
    }
  }

  private safetiesOpenCount(): number {
    let c = 0;
    for (let i = 0; i < 3; i++) if (this._safetyOpen[i]!) c++;
    return c;
  }

  private porvFlowOpen(): boolean {
    return (this._porvAuto || this._porvStuck) && !this._blockClosed;
  }

  private outputs(reliefRate: number): PressureReliefOutputs {
    return {
      reliefRateMPaPerS: reliefRate,
      porvOpen: this.porvFlowOpen(),
      porvStuckOpen: this._porvStuck,
      blockValveClosed: this._blockClosed,
      safetiesOpen: this.safetiesOpenCount(),
      ltopPorvOpen: this._ltopPorvOpen,
      prtVentDriveKpa: this._prtVentDriveKpa,
      discharging: this._prtDischarging,
    };
  }

  // ------------------------------------------------------------------------- view ----

  view(): PressureReliefView {
    const en: string[] = [];
    const zh: string[] = [];
    const alarm = (e: string, z: string) => {
      en.push(e);
      zh.push(z);
    };
    // Annunciator wording lifted from the C# annunciator table (Pages/ReactorModule.xaml.cs
    // L1407–1411 / L1449; conditions from ReactorSimService L5751–5756 / L4861).
    if (this.safetiesOpenCount() > 0) alarm('PZR SAFETY OPEN', '穩壓器安全閥起跳');
    if (this._prtPressurePsig > PrtAlarmPressPsig) alarm('PRT PRESS HI', '釋壓缸壓力高');
    if (this._prtWaterTempK - 273.15 > PrtAlarmTempC) alarm('PRT TEMP HI', '釋壓缸溫度高');
    if (this._prtLevelPct > PrtAlarmLevelHiPct || this._prtLevelPct < PrtAlarmLevelLoPct)
      alarm('PRT LEVEL ABNORMAL', '釋壓缸水位異常');
    if (this._prtDiscBurst) alarm('PRT RUPTURE DISC BURST', '釋壓缸爆破片爆裂');
    if (this._ltopPorvOpen) alarm('LTOP/COMS RELIEVING', '低溫超壓保護洩放');

    // One-line PORV status (dynamic physics string — stays in the module as an En/Zh pair).
    let statusEn: string;
    let statusZh: string;
    if (this._porvStuck && this._blockClosed) {
      statusEn = 'PORV stuck open — isolated by block valve';
      statusZh = '釋壓閥卡開 — 已由隔離閥隔離';
    } else if (this._porvStuck) {
      statusEn = 'PORV STUCK OPEN — discharge continues';
      statusZh = '釋壓閥卡開 — 持續排放';
    } else if (this._blockClosed) {
      statusEn = 'PORV isolated (block valve closed)';
      statusZh = '釋壓閥已隔離（隔離閥關閉）';
    } else if (this._porvAuto) {
      statusEn = 'PORV relieving';
      statusZh = '釋壓閥洩放中';
    } else {
      statusEn = 'PORV shut';
      statusZh = '釋壓閥關閉';
    }

    return {
      porvCommandOpen: this._porvAuto,
      porvFlowOpen: this.porvFlowOpen(),
      porvStuckOpen: this._porvStuck,
      porvStuckPending: this._stickPending,
      blockValveClosed: this._blockClosed,
      safetyOpen: [...this._safetyOpen],
      safetiesOpen: this.safetiesOpenCount(),
      ltopArmed: this._ltopArmed,
      ltopPorvOpen: this._ltopPorvOpen,
      reliefRateMPaPerS: this._lastReliefRate,
      prtPressurePsig: this._prtPressurePsig,
      prtTempC: this._prtWaterTempK - 273.15,
      prtTempF: (this._prtWaterTempK - 273.15) * 1.8 + 32.0, // source L899
      prtLevelPct: this._prtLevelPct,
      ruptureDiscBurst: this._prtDiscBurst,
      discharging: this._prtDischarging,
      prtVentDriveKpa: this._prtVentDriveKpa,
      alarmsEn: en,
      alarmsZh: zh,
      porvStatusEn: statusEn,
      porvStatusZh: statusZh,
    };
  }
}

// Setpoints exported for tests / panel scales (values are the C# constants above).
export const PressureReliefSetpoints = {
  PorvOpenPressure,
  PorvClosePressure,
  PorvReliefRate,
  PzrSafetySet: [PzrSafety1Set, PzrSafety2Set, PzrSafety3Set] as const,
  PzrSafetyAccum,
  PzrSafetyBlowdown,
  PzrSafetyReliefRate,
  LtopOpenPressureMPa,
  LtopCloseHystMPa,
  PrtDiscBurstPsig,
  PrtAlarmPressPsig,
  PrtAlarmTempC,
  PrtAlarmLevelHiPct,
  PrtAlarmLevelLoPct,
} as const;
