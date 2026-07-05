# Reactor simulator — fidelity checklist vs `WinForge/Services/ReactorSimService.cs`

_Status as of 2026-07-03 (feature/reactor-cvcs). The C# source is ~6,500 lines + 2,900 lines of
headless tests; this tracks which of its systems the TypeScript engine (`src/reactor/`) has._

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
| CSF status trees | ❌ | source L~2600 |
| Appendix-G P/T limits, LTOP, PTS | ❌ | source `UpdatePtLimits` |
| PORV / code safeties / PRT, MSSV banks | ❌ | |
| RCP seal-LOCA model, containment, AVR | ❌ | |
| Calorimetric power (net-cal bias) | 🟡 | bias folded into pump-heat constant |

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
| Rod bank A–D overlap program (228 steps, 128 overlap, 8–72 spm) | ❌ | port uses per-bank % + uniform demand |
| Tavg/Tref automatic rod controller | ❌ | |

## UI

| Surface | Status | Notes |
|---|---|---|
| Analog gauges, annunciator (latching/ACK), NIS, permissive lamps, MODE annunciator | ✅ | prior wave |
| **Fuel factory screens** (inventory, fabricate, load/discharge, spent pool) | ✅ | `FuelCvcsPanel`, trilingual |
| **CVCS blender lineup + dilution drill/terminate + time-to-crit readout** | ✅ | |
| Reactimeter panel (mark/worth) | 🟡 | state exposed; dedicated panel not yet |
| Trends: full strip-chart suite (source has multi-pen recorders) | 🟡 | two sparklines |

## Next (in rough order)

1. Rod bank overlap program + withdrawal speed limits (steps/min) + Tavg/Tref auto controller.
2. App-G P/T limits + LTOP + PORV/safeties (heatup/cooldown protection envelope).
3. SI model (2000 ppm boron, accumulators) + CSF status trees.
4. Reactimeter panel + estimated-critical-boron worksheet UI.
5. Containment / PRT / MSSV / seal-LOCA scenario set.
