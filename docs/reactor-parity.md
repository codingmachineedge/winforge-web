# Reactor simulator — fidelity checklist vs `WinForge/Services/ReactorSimService.cs`

_Status as of 2026-07-05 (feature/reactor-protection-wave). The C# source is ~6,500 lines + 2,900
lines of headless tests; this tracks which of its systems the TypeScript engine (`src/reactor/`) has._

The 2026-07-05 wave ported six protection/ESF subsystems as standalone pure engines, each with its
own vitest suite and control-room panel, wired onto the live `ReactorSim` by the single-writer
coordinator `src/reactor/reactorAux.ts` (steps them in the C# tick order — rod control before
`update()`; relief → P/T limits → ESF → containment → CSF after — honouring the one-tick-lag
couplings LTOP↔PORV, PRT→containment, containment→relief). 191 reactor tests green.

Legend: ✅ ported (tested) · 🟡 partial · ❌ not yet

## Core physics

| System | Status | Notes |
|---|---|---|
| 6-group point kinetics + prompt lifetime | ✅ | backward-Euler, 50 Hz substepping |
| Reactivity components (rod/boron/Doppler/MTC/Xe/Sm) | ✅ | MTC EOL slope, cycle-dependent β |
| ANS-5.1 decay heat (23 groups + actinides) | ✅ | exact discrete recurrence |
| Xenon/iodine + samarium dynamics, restart pit | ✅ | `triggerXenonRestart` |
| Burnup, cycle fraction, BOL/MOL/EOL, critical-boron interpolation | ✅ | |
| Thermal-hydraulics (fuel/coolant lumps, SG sink, ΔT spread) | ✅ | lumped, sim-scale |
| RCP flow dynamics (spin-up, coastdown, natural circulation) | ✅ | 4 loops |
| **RCP pump heat / heatup path** | ✅ | 6 MW/pump − ambient loss; cold → MODE 3 on pumps alone |
| Pressurizer (saturated model, heaters, spray, level program) | ✅ | |
| Meltdown / core-damage accrual | ✅ | |

## Instrumentation & protection

| System | Status | Notes |
|---|---|---|
| SR/IR/PR nuclear instrumentation + 1/M + SUR (DPM) | ✅ | self-calibrated SR floor |
| P-6 / P-10 permissives (hysteresis latches), P-7/8/9 | ✅ | SR HV removal above P-6 |
| Reactimeter (inverse point kinetics, mark/worth) | ✅ | independent of engine state |
| Tech-Spec MODE 1–6 (sticky latches, refueling latch) | ✅ | |
| RPS trips: PR high flux, IR high flux, SR (via P-6 gating), short period, hot-leg T, pressure, low flow | ✅ | exercised by the startup-sequence test |
| Alarms (EN/粵語) incl. dilution doubling + action window | ✅ | |
| Subcooling margin | ✅ | |
| CSF status trees | ✅ | `csfTrees.ts` — six F-0 trees (S/C/H/P/Z/I), Green/Yellow/Orange/Red, FR ids, bilingual conditions; `CsfPanel` board |
| Appendix-G P/T limits, LTOP, PTS | ✅ | `ptLimits.ts` — App-G envelope + heatup/cooldown rate + LTOP arm (135 °C, 5 °C hyst) + PTS (RT_PTS vs EFPY); `PtLimitsPanel` P/T diagram |
| PORV / code safeties / PRT, MSSV banks | ✅ | PORV+3 safeties+PRT+stuck-PORV drill in `pressureRelief.ts`; MSSV bank in `engineeredSafety.ts` |
| RCP seal-LOCA model, containment | ✅ | `containment.ts` — pressure lump, Hi-1/2/3, spray, sump, WOG-2000 seal-LOCA on CCW loss |
| Safety Injection (SI) + accumulators | ✅ | `engineeredSafety.ts` — lo-press/lo-steamline/manual SI, 2000 ppm borated HHSI, passive accumulators < 4.5 MPa |
| Calorimetric power (net-cal bias) | 🟡 | bias folded into pump-heat constant |
| AVR / turbine-first-stage load signal | 🟡 | rod-control Tref uses electric-power/rated as the load proxy until a turbine module exists |

## CVCS / chemistry

| System | Status | Notes |
|---|---|---|
| Boron slew at 4.0 ppm/s toward target | ✅ | source `UpdateBoron` clamp |
| **Blender modes (Auto / Borate 7000 / Dilute / AlternateDilute)** | ✅ | operator lineup + `makeupBlendPpm` readout |
| **Uncontrolled-dilution scenario** (exp blend-out, 80 kgal, 150 gpm, doubling alarm, 15-min action window, terminate) | ✅ | `startUncontrolledDilution` / drill button |
| Time-to-criticality + dilution action margin | ✅ | controlled + uncontrolled paths |
| VCT level / letdown-charging inventory detail | ❌ | simplified to the blend concentration |
| SI boron (2000 ppm on safety injection) | ❌ | no SI model yet |

## Fuel cycle

| System | Status | Notes |
|---|---|---|
| Fuel factory (fabricate → fresh → load → burnup → auto-discharge → spent) | ✅ | signed payloads, anti-replay ledger |
| Validation (forged/tampered/spent/depleted/enrichment) | ✅ | bilingual reasons |
| **Fuel gate** (no fuel → rod withdrawal + Startup/Run blocked, note) | ✅ | enforced in the engine controls |
| **Burnup accrual into loaded assemblies** (mass-share, 50 GWd/t auto-discharge) | ✅ | wired per-tick in `useReactorSim` |
| Easy-mode burn penalty (1.75×) | ✅ | `fuelConsumptionMultiplier` |
| Auto-start penalty (2.5×) | ✅ | `autoStartMode` (SCRAM suppression + 2.5× burn), redeemed via power credits (`powerCredits.ts`) |
| Counterfeit-harm injection | ✅ | `injectFuelHarm` ↔ `LoadResult.harmful` |

## Startup sequence (the "not instant" guarantee)

| Property | Status | Notes |
|---|---|---|
| Fuel load required before startup | ✅ | integration test |
| Pump-heat heatup MODE 5→4→3 (minutes of sim-time) | ✅ | |
| SGs to service gently (feed step = cooldown excursion → trip) | ✅ | trip verified in test iteration |
| Dilution toward ECC, batched near critical (flat-out dilute → period trip) | ✅ | |
| SUR-limited rod withdrawal, P-6 latch during approach | ✅ | |
| Criticality > 15 sim-minutes from cold, only after hot standby | ✅ | |
| MODE 2 power ascension (multi-decade, tame SUR) | ✅ | |
| MODE 1 / P-10 full-power ascension from cold | 🟡 | engine's lumped Doppler-vs-conductance scale settles low; `warmStartCritical` covers the at-power regime |
| Rod bank A–D overlap program (228 steps, 128 overlap, 8–72 spm) | ✅ | `rodControl.ts` — demand counter 0..528, bank sequencing, speed-limited drive; `RodControlPanel` |
| Tavg/Tref automatic rod controller | ✅ | `rodControl.ts` AUTO mode — Tref program (289.6→305 °C), ±1.5 °F deadband, 57.6 spm/°C |

## UI

| Surface | Status | Notes |
|---|---|---|
| Analog gauges, annunciator (latching/ACK), NIS, permissive lamps, MODE annunciator | ✅ | prior wave |
| **Fuel factory screens** (inventory, fabricate, load/discharge, spent pool) | ✅ | `FuelCvcsPanel`, trilingual |
| **CVCS blender lineup + dilution drill/terminate + time-to-crit readout** | ✅ | |
| Reactimeter panel (mark/worth) | ✅ | `ReactimeterPanel` — measured ρ/period/SUR + mark/clear worth swing |
| Rod control panel (overlap program, Tavg/Tref, drive) | ✅ | `RodControlPanel` |
| P/T-limits panel (App-G diagram, LTOP, PTS) | ✅ | `PtLimitsPanel` |
| Pressurizer-relief panel (PORV/safeties/PRT, TMI drill) | ✅ | `PressureReliefPanel` |
| ESF panel (SI / accumulators / MSSV bank) | ✅ | `EsfPanel` |
| Containment panel (Hi-1/2/3, spray, sump, seal-LOCA) | ✅ | `ContainmentPanel` |
| CSF status board (six F-0 trees) | ✅ | `CsfPanel` |
| Trends: full strip-chart suite (source has multi-pen recorders) | 🟡 | two sparklines |

## Next (in rough order)

1. Estimated-critical-boron worksheet UI + multi-pen strip-chart recorder suite.
2. Turbine / secondary module → real Tavg/Tref load signal + AVR + steam-dump program.
3. Containment combustible-H₂ model (10 CFR 50.44) — deliberately skipped this wave (see
   `containment.ts` notes); LOCA / MSLB / SGTR break scenarios feeding containment + ESF.
4. Calorimetric net-cal bias as a first-class channel (currently folded into the pump-heat constant).
5. Full MODE 1 / P-10 cold-to-full-power ascension (lumped Doppler-vs-conductance scale tuning).

## UI surface change 2026-07-05 (Material-design-rewrite handoff)

The reactor route is now the **Control Room console** (`src/components/reactor/controlRoom/`,
design: the handoff's "Reactor Control Room.dc.html") — a full replace per the user's decision.
The engineering panels listed below are **unmounted from the UI** but their components remain in
the repo and ALL engines keep running via `reactorAux` (their annunciators surface on the
control-room alarm board). A turbine/secondary balance-of-plant module (`turbineSecondary.ts`)
was added for the console: governor roll to 1800 rpm, generator auto-sync, steam dump, SG level,
breaker-gated gross MWe (now the sim's electric output).

## Ported 2026-07-05 (feature/reactor-protection-wave)

Six new pure-engine modules under `src/reactor/`, each with a vitest suite, a control-room panel
under `src/components/reactor/`, and a trilingual i18n slice under `src/i18n/`:

| Module | Engine | Panel | i18n ns |
|---|---|---|---|
| Rod overlap + Tavg/Tref auto control | `rodControl.ts` | `RodControlPanel` | `reactorrods` |
| PORV / code safeties / PRT (+ TMI drill) | `pressureRelief.ts` | `PressureReliefPanel` | `reactorrelief` |
| App-G P/T limits + LTOP + PTS | `ptLimits.ts` | `PtLimitsPanel` | `reactorptlim` |
| SI + accumulators + MSSV bank | `engineeredSafety.ts` | `EsfPanel` | `reactoresf` |
| Containment + RCP seal-LOCA | `containment.ts` | `ContainmentPanel` | `reactorctmt` |
| Six CSF status trees (F-0) | `csfTrees.ts` | `CsfPanel` | `reactorcsf` |
| Reactimeter (mark/worth) UI | (engine already present) | `ReactimeterPanel` | `reactorrmtr` |

Wired by `src/reactor/reactorAux.ts` (coordinator) into `useReactorSim` / `ReactorView`. Coordinator
integration is covered by `src/reactor/reactorAux.test.ts` (11 scenario tests: LTOP arming, PORV
relief, stuck-PORV isolation, SI boration, AUTO rod engagement, CSF evaluation, seal-LOCA, reset).
