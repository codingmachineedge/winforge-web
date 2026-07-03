import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Nuclear Cake Factory & Farm — faithful port of WinForge CakeFactoryService.
// Real-time interactive sim: a reactor bus powers a farm + ingredient factories
// + a 7-stage bakery line. The C# service is ~5000 LOC of deep telemetry; this
// port keeps the CORE economy and control loop (power gating, farm growth,
// harvest, dairy/eggs, ingredient factory runs w/ QA lab release, batch-kit
// staging, the batch stage machine w/ safety gates, orders/dispatch, supply
// deliveries, CIP) and consolidates the per-machine sub-telemetry.
// ---------------------------------------------------------------------------

type Recipe = {
  key: string;
  batchSize: number;
  flourKg: number;
  sugarKg: number;
  eggCount: number;
  butterKg: number;
  milkL: number;
  bakingPowderKg: number;
  saltKg: number;
  vanillaL: number;
  cocoaKg: number;
  mixSeconds: number;
  bakeSeconds: number;
  ovenSetpointC: number;
  targetSpecificGravity: number;
};

// Recipes ported verbatim (constants from CakeFactoryService.Recipes).
const RECIPES: Recipe[] = [
  {
    key: 'white-layer', batchSize: 12,
    flourKg: 0.244, sugarKg: 0.35, eggCount: 4.0, butterKg: 0.17, milkL: 0.24,
    bakingPowderKg: 0.016, saltKg: 0.006, vanillaL: 0.005, cocoaKg: 0,
    mixSeconds: 18, bakeSeconds: 42, ovenSetpointC: 176, targetSpecificGravity: 0.82,
  },
  {
    key: 'butter-pound', batchSize: 10,
    flourKg: 0.25, sugarKg: 0.25, eggCount: 3.4, butterKg: 0.25, milkL: 0.07,
    bakingPowderKg: 0.008, saltKg: 0.004, vanillaL: 0.004, cocoaKg: 0,
    mixSeconds: 22, bakeSeconds: 52, ovenSetpointC: 168, targetSpecificGravity: 0.92,
  },
  {
    key: 'chocolate', batchSize: 12,
    flourKg: 0.225, sugarKg: 0.31, eggCount: 3.0, butterKg: 0.12, milkL: 0.26,
    bakingPowderKg: 0.013, saltKg: 0.005, vanillaL: 0.004, cocoaKg: 0.045,
    mixSeconds: 20, bakeSeconds: 40, ovenSetpointC: 176, targetSpecificGravity: 0.86,
  },
];

const STAGES = [
  'idle', 'scaling', 'mixing', 'depositing', 'baking', 'cooling', 'icing', 'packaging',
] as const;
type Stage = (typeof STAGES)[number];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function icingNeedKg(r: Recipe): number {
  return r.batchSize * (r.key === 'butter-pound' ? 0.075 : 0.12);
}

// Consolidated icing formula (from IcingFormula).
function icingFormula(r: Recipe) {
  const target = Math.max(icingNeedKg(r) * 1.25, 1.1);
  const chocolate = r.cocoaKg > 0;
  const sugar = target * (chocolate ? 0.5 : 0.56);
  const butter = target * (r.key === 'butter-pound' ? 0.25 : 0.2);
  const milk = target * (r.key === 'butter-pound' ? 0.1 : 0.16);
  const vanilla = target * 0.015;
  const cocoa = chocolate ? target * 0.12 : 0;
  const product = (sugar + butter + milk + vanilla + cocoa) * 0.98;
  return { sugar, butter, milk, vanilla, cocoa, product };
}

function stageDuration(r: Recipe, stage: Stage): number {
  switch (stage) {
    case 'scaling': return 8;
    case 'mixing': return r.mixSeconds;
    case 'depositing': return 7;
    case 'baking': return r.bakeSeconds;
    case 'cooling': return 18;
    case 'icing': return 15;
    case 'packaging': return 9;
    default: return 1;
  }
}

// ---------------------------------------------------------------------------
// Ingredient factory runs. Each converts inputs → a product held for QA lab
// release, consuming utilities (process water / steam / air / filter media).
// ---------------------------------------------------------------------------

type FactoryKind =
  | 'mill' | 'sugar' | 'milk' | 'butter' | 'vanilla' | 'cocoa' | 'salt'
  | 'starch' | 'soda' | 'leavening' | 'packaging' | 'icing' | 'feed'
  | 'bedding' | 'mineral';

type FactoryRun = {
  kind: FactoryKind;
  name: string;
  duration: number;
  elapsed: number;
  powerMW: number;
  product: number;
  waste: number;
  processWaterL: number;
  culinarySteamKg: number;
  compressedAirNm3: number;
  filterMediaPct: number;
  outputField: keyof SimState & string;
};

type PendingLab = {
  product: string;
  qualityPct: number;
} | null;

type SimState = {
  running: boolean;
  recipeIndex: number;
  farmIntensity: number; // 0..1
  lineSpeed: number; // 0..1
  autoHarvest: boolean;

  // Reactor (external dependency, modelled as a local toggle).
  reactorOnline: boolean;
  reactorSetMW: number;
  reactorMW: number;
  powerAvailability: number;

  // Batch line.
  stage: Stage;
  stageReady: boolean;
  stageSeconds: number;
  batchInternalC: number;
  batchQuality: number;
  mixerSpecificGravity: number;
  ovenTemperatureC: number;
  sanitationScore: number;
  cipSeconds: number;

  // Farm growth.
  wheatGrowth: number;
  beetGrowth: number;
  vanillaGrowth: number;
  cocoaGrowth: number;
  pastureHealth: number;
  dairyReadyL: number;
  eggsReady: number;

  // Raw farm stock.
  wheatKg: number;
  sugarCropKg: number;
  vanillaBeansKg: number;
  cocoaBeansKg: number;
  rawMilkL: number;
  strawKg: number;
  brineL: number;
  sodaAshKg: number;

  // Refined ingredient inventory.
  flourKg: number;
  sugarKg: number;
  eggs: number;
  milkL: number;
  butterKg: number;
  bakingPowderKg: number;
  saltKg: number;
  vanillaL: number;
  cocoaKg: number;
  starchKg: number;
  icingKg: number;
  packagingUnits: number;

  // Utilities.
  processWaterL: number;
  culinarySteamKg: number;
  compressedAirNm3: number;
  filterMediaPct: number;

  // Warehouse / logistics.
  forkliftBatteryPct: number;
  warehousePalletSpacePct: number;

  // Ingredient factory run + QA lab.
  run: FactoryRun | null;
  pendingLab: PendingLab;

  // Batch kit staging.
  batchKitStaged: boolean;
  batchKitRecipeKey: string;
  batchKitMassKg: number;

  // Supply delivery.
  supplyEnRoute: boolean;
  supplyArrived: boolean;
  supplyEtaSeconds: number;
  supplyOrderCost: number;

  // Orders / economy.
  finishedGoodsCakes: number;
  cakesBaked: number;
  cakesPacked: number;
  cakesRejected: number;
  ordersFulfilled: number;
  orderSequence: number;
  currentOrderId: string;
  orderCakesRequired: number;
  orderSecondsRemaining: number;
  orderReward: number;
  cashBalance: number;
  reputationPct: number;
  dispatchTruckChargePct: number;
  dispatchColdChainC: number;

  lotSequence: number;
  message: string;
};

function initialState(): SimState {
  return {
    running: true,
    recipeIndex: 0,
    farmIntensity: 0.78,
    lineSpeed: 0.72,
    autoHarvest: false,

    reactorOnline: true,
    reactorSetMW: 42,
    reactorMW: 42,
    powerAvailability: 0,

    stage: 'idle',
    stageReady: false,
    stageSeconds: 0,
    batchInternalC: 22,
    batchQuality: 96,
    mixerSpecificGravity: 1.0,
    ovenTemperatureC: 24,
    sanitationScore: 94,
    cipSeconds: 0,

    wheatGrowth: 64,
    beetGrowth: 58,
    vanillaGrowth: 34,
    cocoaGrowth: 52,
    pastureHealth: 76,
    dairyReadyL: 18,
    eggsReady: 42,

    wheatKg: 260,
    sugarCropKg: 380,
    vanillaBeansKg: 9.5,
    cocoaBeansKg: 60,
    rawMilkL: 90,
    strawKg: 170,
    brineL: 900,
    sodaAshKg: 28,

    flourKg: 120,
    sugarKg: 92,
    eggs: 240,
    milkL: 140,
    butterKg: 28,
    bakingPowderKg: 14,
    saltKg: 18,
    vanillaL: 2.8,
    cocoaKg: 20,
    starchKg: 24,
    icingKg: 8.0,
    packagingUnits: 160,

    processWaterL: 6000,
    culinarySteamKg: 2600,
    compressedAirNm3: 900,
    filterMediaPct: 100,

    forkliftBatteryPct: 88,
    warehousePalletSpacePct: 62,

    run: null,
    pendingLab: null,

    batchKitStaged: false,
    batchKitRecipeKey: '',
    batchKitMassKg: 0,

    supplyEnRoute: false,
    supplyArrived: false,
    supplyEtaSeconds: 0,
    supplyOrderCost: 260,

    finishedGoodsCakes: 0,
    cakesBaked: 0,
    cakesPacked: 0,
    cakesRejected: 0,
    ordersFulfilled: 0,
    orderSequence: 5100,
    currentOrderId: 'ORD-005100',
    orderCakesRequired: 12,
    orderSecondsRemaining: 420,
    orderReward: 240,
    cashBalance: 500,
    reputationPct: 84,
    dispatchTruckChargePct: 76,
    dispatchColdChainC: 4.2,

    lotSequence: 2400,
    message: '',
  };
}

const PROCESS_WATER_CAP = 9000;
const CULINARY_STEAM_CAP = 4200;
const COMPRESSED_AIR_CAP = 1500;

function currentRecipe(s: SimState): Recipe {
  return RECIPES[clamp(s.recipeIndex, 0, RECIPES.length - 1)]!;
}

function batchIngredientMass(r: Recipe): number {
  const n = r.batchSize;
  return n * (r.flourKg + r.sugarKg + r.butterKg + r.milkL + r.bakingPowderKg + r.saltKg + r.vanillaL + r.cocoaKg + r.eggCount * 0.052);
}

// Missing-ingredient check for the current recipe (from MissingIngredients).
function missingIngredients(s: SimState, r: Recipe): string[] {
  const n = r.batchSize;
  const m: string[] = [];
  if (s.flourKg < r.flourKg * n) m.push('flour');
  if (s.sugarKg < r.sugarKg * n) m.push('sugar');
  if (s.eggs < r.eggCount * n) m.push('eggs');
  if (s.butterKg < r.butterKg * n) m.push('butter');
  if (s.milkL < r.milkL * n) m.push('milk');
  if (s.bakingPowderKg < r.bakingPowderKg * n) m.push('bakingPowder');
  if (s.saltKg < r.saltKg * n) m.push('salt');
  if (s.vanillaL < r.vanillaL * n) m.push('vanilla');
  if (s.cocoaKg < r.cocoaKg * n) m.push('cocoa');
  if (s.icingKg < icingNeedKg(r)) m.push('icing');
  if (s.packagingUnits < n) m.push('cartons');
  return m;
}

function hasUtilities(s: SimState, w: number, st: number, air: number, filt: number): boolean {
  return s.processWaterL >= w && s.culinarySteamKg >= st && s.compressedAirNm3 >= air && s.filterMediaPct >= filt;
}

// ---------------------------------------------------------------------------
// Reducer actions.
// ---------------------------------------------------------------------------

type Action =
  | { t: 'tick'; dt: number }
  | { t: 'toggleRun' }
  | { t: 'setRecipe'; i: number }
  | { t: 'setFarm'; v: number }
  | { t: 'setLine'; v: number }
  | { t: 'setAutoHarvest'; v: boolean }
  | { t: 'toggleReactor' }
  | { t: 'setReactorMW'; v: number }
  | { t: 'harvest' }
  | { t: 'collect' }
  | { t: 'factory'; kind: FactoryKind }
  | { t: 'releaseLab' }
  | { t: 'clean' }
  | { t: 'stageKit' }
  | { t: 'startBatch' }
  | { t: 'advance' }
  | { t: 'orderSupply' }
  | { t: 'unloadSupply' }
  | { t: 'dispatch' };

// A factory-run recipe: input requirement + how the run is built.
type FactorySpec = {
  kind: FactoryKind;
  nameKey: string;
  duration: number;
  powerMW: number;
  processWaterL: number;
  culinarySteamKg: number;
  compressedAirNm3: number;
  filterMediaPct: number;
  outputField: keyof SimState & string;
  // returns run inputs or an error key
  build: (s: SimState) => { product: number; waste: number; consume: (d: Draft) => void } | { error: string };
};

type Draft = SimState;

const FACTORY_SPECS: Record<FactoryKind, FactorySpec> = {
  mill: {
    kind: 'mill', nameKey: 'facMill', duration: 8, powerMW: 1.8,
    processWaterL: 36, culinarySteamKg: 0, compressedAirNm3: 38, filterMediaPct: 0.6,
    outputField: 'flourKg',
    build: (s) => {
      const wheat = Math.min(s.wheatKg, 90);
      if (wheat < 5) return { error: 'errNoWheat' };
      return { product: wheat * 0.77, waste: wheat * 0.03, consume: (d) => { d.wheatKg -= wheat; } };
    },
  },
  sugar: {
    kind: 'sugar', nameKey: 'facSugar', duration: 10, powerMW: 2.2,
    processWaterL: 260, culinarySteamKg: 500, compressedAirNm3: 22, filterMediaPct: 1.2,
    outputField: 'sugarKg',
    build: (s) => {
      const crop = Math.min(s.sugarCropKg, 160);
      if (crop < 10) return { error: 'errNoCrop' };
      return { product: crop * 0.14, waste: crop * 0.05, consume: (d) => { d.sugarCropKg -= crop; } };
    },
  },
  milk: {
    kind: 'milk', nameKey: 'facMilk', duration: 6.5, powerMW: 1.2,
    processWaterL: 80, culinarySteamKg: 160, compressedAirNm3: 14, filterMediaPct: 0.45,
    outputField: 'milkL',
    build: (s) => {
      const milk = Math.min(s.rawMilkL, 60);
      if (milk < 5) return { error: 'errNoRawMilk' };
      return { product: milk * 0.985, waste: milk * 0.005, consume: (d) => { d.rawMilkL -= milk; } };
    },
  },
  butter: {
    kind: 'butter', nameKey: 'facButter', duration: 7.6, powerMW: 1.4,
    processWaterL: 120, culinarySteamKg: 160, compressedAirNm3: 15, filterMediaPct: 0.8,
    outputField: 'butterKg',
    build: (s) => {
      const milk = Math.min(Math.max(0, s.rawMilkL - 30), 54);
      if (milk < 5) return { error: 'errKeepMilk' };
      const butter = milk * 1.03 * (3.8 / 100) / 0.82 * 0.9;
      return { product: butter, waste: milk * 0.006, consume: (d) => { d.rawMilkL -= milk; } };
    },
  },
  vanilla: {
    kind: 'vanilla', nameKey: 'facVanilla', duration: 7.5, powerMW: 1.0,
    processWaterL: 72, culinarySteamKg: 85, compressedAirNm3: 10, filterMediaPct: 0.35,
    outputField: 'vanillaL',
    build: (s) => {
      const beans = Math.min(s.vanillaBeansKg, 5.5);
      if (beans < 0.5) return { error: 'errNoVanillaBeans' };
      return { product: beans * 0.42, waste: beans * 0.08, consume: (d) => { d.vanillaBeansKg -= beans; } };
    },
  },
  cocoa: {
    kind: 'cocoa', nameKey: 'facCocoa', duration: 12.4, powerMW: 2.05,
    processWaterL: 32, culinarySteamKg: 0, compressedAirNm3: 58, filterMediaPct: 0.95,
    outputField: 'cocoaKg',
    build: (s) => {
      const beans = Math.min(s.cocoaBeansKg, 45);
      if (beans < 5) return { error: 'errNoCocoaBeans' };
      return { product: beans * 0.52, waste: beans * 0.025, consume: (d) => { d.cocoaBeansKg -= beans; } };
    },
  },
  salt: {
    kind: 'salt', nameKey: 'facSalt', duration: 9, powerMW: 1.9,
    processWaterL: 18, culinarySteamKg: 780, compressedAirNm3: 38, filterMediaPct: 0.65,
    outputField: 'saltKg',
    build: (s) => {
      const brine = Math.min(s.brineL, 600);
      if (brine < 80) return { error: 'errNoBrine' };
      return { product: brine * 0.16, waste: brine * 0.02, consume: (d) => { d.brineL -= brine; } };
    },
  },
  starch: {
    kind: 'starch', nameKey: 'facStarch', duration: 8.5, powerMW: 1.6,
    processWaterL: 85, culinarySteamKg: 140, compressedAirNm3: 16, filterMediaPct: 0.45,
    outputField: 'starchKg',
    build: (s) => {
      const grain = Math.min(s.wheatKg, 90);
      if (grain < 52) return { error: 'errNoGrain' };
      return { product: grain * 0.28, waste: grain * 0.18, consume: (d) => { d.wheatKg -= grain; } };
    },
  },
  soda: {
    kind: 'soda', nameKey: 'facSoda', duration: 8.2, powerMW: 1.5,
    processWaterL: 56, culinarySteamKg: 70, compressedAirNm3: 18, filterMediaPct: 0.55,
    outputField: 'sodaAshKg',
    build: (s) => {
      const ash = Math.min(s.sodaAshKg, 40);
      if (ash < 6) return { error: 'errNoSodaAsh' };
      // baking soda folds back into leavening feedstock; store in bakingPowder buffer via soda field.
      return { product: ash * 1.05, waste: ash * 0.03, consume: (d) => { d.sodaAshKg -= ash; } };
    },
  },
  leavening: {
    kind: 'leavening', nameKey: 'facLeavening', duration: 8.4, powerMW: 1.3,
    processWaterL: 0, culinarySteamKg: 0, compressedAirNm3: 58, filterMediaPct: 1.3,
    outputField: 'bakingPowderKg',
    build: (s) => {
      if (s.sodaAshKg < 3 || s.starchKg < 2) return { error: 'errNoLeavenFeed' };
      const powder = (Math.min(s.sodaAshKg, 8) + Math.min(s.starchKg, 6)) * 0.9;
      return {
        product: powder, waste: powder * 0.025,
        consume: (d) => { d.sodaAshKg = Math.max(0, d.sodaAshKg - 6); d.starchKg = Math.max(0, d.starchKg - 4); },
      };
    },
  },
  packaging: {
    kind: 'packaging', nameKey: 'facPackaging', duration: 9, powerMW: 1.7,
    processWaterL: 24, culinarySteamKg: 0, compressedAirNm3: 52, filterMediaPct: 0.6,
    outputField: 'packagingUnits',
    build: () => ({ product: 48, waste: 3, consume: () => { /* uses received paperboard implicitly */ } }),
  },
  icing: {
    kind: 'icing', nameKey: 'facIcing', duration: 6.8, powerMW: 0.9,
    processWaterL: 38, culinarySteamKg: 46, compressedAirNm3: 12, filterMediaPct: 0.22,
    outputField: 'icingKg',
    build: (s) => {
      const r = currentRecipe(s);
      const f = icingFormula(r);
      if (s.sugarKg < f.sugar || s.butterKg < f.butter || s.milkL < f.milk || s.vanillaL < f.vanilla || s.cocoaKg < f.cocoa) {
        return { error: 'errNoIcingInputs' };
      }
      return {
        product: f.product, waste: f.product * 0.018,
        consume: (d) => {
          d.sugarKg -= f.sugar; d.butterKg -= f.butter; d.milkL -= f.milk; d.vanillaL -= f.vanilla; d.cocoaKg -= f.cocoa;
        },
      };
    },
  },
  feed: {
    kind: 'feed', nameKey: 'facFeed', duration: 8, powerMW: 1.1,
    processWaterL: 28, culinarySteamKg: 55, compressedAirNm3: 18, filterMediaPct: 0.25,
    outputField: 'strawKg',
    build: (s) => {
      if (s.wheatKg < 42) return { error: 'errNoGrain' };
      return { product: 40, waste: 2, consume: (d) => { d.wheatKg -= 42; } };
    },
  },
  bedding: {
    kind: 'bedding', nameKey: 'facBedding', duration: 7.5, powerMW: 1.0,
    processWaterL: 18, culinarySteamKg: 0, compressedAirNm3: 26, filterMediaPct: 0.35,
    outputField: 'strawKg',
    build: (s) => {
      if (s.strawKg < 54) return { error: 'errNoStraw' };
      return { product: 48, waste: 4, consume: (d) => { d.strawKg -= 54; } };
    },
  },
  mineral: {
    kind: 'mineral', nameKey: 'facMineral', duration: 7.2, powerMW: 1.0,
    processWaterL: 12, culinarySteamKg: 0, compressedAirNm3: 22, filterMediaPct: 0.3,
    outputField: 'saltKg',
    build: (s) => {
      if (s.saltKg < 4) return { error: 'errNoMineralFeed' };
      return { product: 6, waste: 1, consume: (d) => { d.saltKg = Math.max(0, d.saltKg - 4); } };
    },
  },
};

// The player-facing factory buttons (subset shown in the toolbar).
const FACTORY_BUTTONS: FactoryKind[] = ['mill', 'sugar', 'milk', 'butter', 'cocoa', 'vanilla', 'salt', 'icing'];

function powerGate(s: SimState): number {
  const farmDemand = 0.7 + s.farmIntensity * 3.8;
  const factoryDemand = 2.4 + s.lineSpeed * 28.0 + (s.cipSeconds > 0 ? 2.8 : 0) + (s.run?.powerMW ?? 0);
  const demand = farmDemand + factoryDemand;
  const online = s.reactorOnline && s.reactorMW > 1;
  return online ? clamp(s.reactorMW / Math.max(1, demand), 0, 1) : 0;
}

function powerDemand(s: SimState): number {
  const farmDemand = 0.7 + s.farmIntensity * 3.8;
  const factoryDemand = 2.4 + s.lineSpeed * 28.0 + (s.cipSeconds > 0 ? 2.8 : 0) + (s.run?.powerMW ?? 0);
  return farmDemand + factoryDemand;
}

function stageSafetyGateMet(s: SimState): boolean {
  switch (s.stage) {
    case 'baking': return s.batchInternalC >= 71;
    case 'cooling': return s.batchInternalC <= 35;
    case 'icing': return s.sanitationScore >= 62;
    case 'packaging': return s.sanitationScore >= 58;
    default: return true;
  }
}

function liveQuality(s: SimState, power: number): number {
  const r = currentRecipe(s);
  const ovenPenalty = s.stage === 'baking' ? Math.max(0, r.ovenSetpointC - s.ovenTemperatureC) * 0.11 : 0;
  const sanitationPenalty = Math.max(0, 72 - s.sanitationScore) * 0.28;
  const stageIdx = STAGES.indexOf(s.stage);
  const gravityPenalty = stageIdx >= STAGES.indexOf('mixing')
    ? Math.abs(s.mixerSpecificGravity - r.targetSpecificGravity) * 45
    : 0;
  return clamp(s.batchQuality + power * 3.5 - ovenPenalty - sanitationPenalty - gravityPenalty, 0, 100);
}

function nextStage(stage: Stage): Stage {
  const i = STAGES.indexOf(stage);
  if (stage === 'packaging') return 'idle';
  return STAGES[i + 1] ?? 'idle';
}

// ---------------------------------------------------------------------------
// The tick step — ported from CakeFactoryService.Tick and its Update* helpers,
// consolidated. dt is clamped as in the C# service.
// ---------------------------------------------------------------------------

function step(prev: SimState, dt: number): SimState {
  const s: SimState = { ...prev };
  const seconds = clamp(dt, 0.016, 0.25);
  const r = currentRecipe(s);

  // Reactor ramp toward set point.
  s.reactorMW += ((s.reactorOnline ? s.reactorSetMW : 0) - s.reactorMW) * Math.min(1, seconds / 4.0);
  if (s.reactorMW < 0.05) s.reactorMW = 0;

  const power = powerGate(s);
  s.powerAvailability = power;

  // --- Farm growth (UpdateFarm, consolidated) ---
  const fieldEffect = s.farmIntensity * (0.12 + 0.88 * power);
  s.wheatGrowth = Math.min(100, s.wheatGrowth + seconds * 0.16 * fieldEffect);
  s.beetGrowth = Math.min(100, s.beetGrowth + seconds * 0.13 * fieldEffect);
  s.pastureHealth = clamp(s.pastureHealth + seconds * (0.09 * fieldEffect - 0.015), 10, 100);
  s.vanillaGrowth = Math.min(100, s.vanillaGrowth + seconds * 0.045 * fieldEffect);
  s.cocoaGrowth = Math.min(100, s.cocoaGrowth + seconds * 0.04 * fieldEffect);

  if (s.autoHarvest && power >= 0.15) {
    if (s.wheatGrowth >= 100) { s.wheatKg += 390 * (0.92 + Math.random() * 0.16); s.wheatGrowth = 10 + Math.random() * 7; }
    if (s.beetGrowth >= 100) { s.sugarCropKg += 760 * (0.92 + Math.random() * 0.16); s.beetGrowth = 10 + Math.random() * 7; }
    if (s.vanillaGrowth >= 100) { s.vanillaBeansKg += 5.5 + Math.random() * 1.4; s.vanillaGrowth = 9 + Math.random() * 6; }
  }

  // Livestock: milk + eggs accrue into ready buffers (consolidated).
  const livestockPower = s.farmIntensity * power;
  const simHours = seconds * 0.05 * Math.max(0.25, s.farmIntensity);
  const milkRate = 14 * 1.15 * livestockPower * clamp(s.pastureHealth / 76, 0.4, 1.1);
  const eggRate = 72 * 0.035 * livestockPower;
  s.dairyReadyL = Math.min(140, s.dairyReadyL + milkRate * simHours);
  s.eggsReady = Math.min(420, s.eggsReady + eggRate * simHours);

  // --- Warehouse (UpdateWarehouse) ---
  if (power >= 0.1) s.forkliftBatteryPct = Math.min(100, s.forkliftBatteryPct + seconds * 0.08 * power);
  if (!s.batchKitStaged) s.warehousePalletSpacePct += (70 - s.warehousePalletSpacePct) * Math.min(1, seconds / 90.0);

  // --- Supply delivery (UpdateSupplyDelivery) ---
  if (s.supplyEnRoute && !s.supplyArrived) {
    const travel = power >= 0.05 ? 1.0 : 0.35;
    s.supplyEtaSeconds = Math.max(0, s.supplyEtaSeconds - seconds * travel);
    if (s.supplyEtaSeconds <= 0) s.supplyArrived = true;
  }

  // --- Orders (UpdateOrders) ---
  s.orderSecondsRemaining -= seconds;
  if (power >= 0.12) {
    s.dispatchTruckChargePct = Math.min(100, s.dispatchTruckChargePct + seconds * 0.06 * power);
    s.dispatchColdChainC += (4.2 - s.dispatchColdChainC) * Math.min(1, seconds / 24.0);
  } else {
    s.dispatchColdChainC += (13.5 - s.dispatchColdChainC) * Math.min(1, seconds / 90.0);
  }
  if (s.orderSecondsRemaining < -120) s.reputationPct = Math.max(0, s.reputationPct - seconds * 0.006);

  // --- Cleaning (UpdateCleaning) ---
  if (s.cipSeconds > 0) {
    const cleanRate = seconds * Math.max(0.1, power);
    s.cipSeconds = Math.max(0, s.cipSeconds - cleanRate);
    s.sanitationScore = Math.min(100, s.sanitationScore + cleanRate * 4.2);
  }

  // --- Factory run (UpdateFactoryRun + CompleteFactoryRun) ---
  if (s.run && power >= 0.2) {
    const run = { ...s.run };
    run.elapsed = Math.min(run.duration, run.elapsed + seconds * clamp(power, 0, 1));
    if (run.elapsed >= run.duration) {
      // complete: product enters inventory, then held for QA lab release.
      const field = run.outputField;
      const cur = s[field] as number;
      const out = run.kind === 'packaging' ? Math.floor(run.product) : run.product;
      (s as unknown as Record<string, number>)[field] = cur + out;
      s.pendingLab = { product: run.kind, qualityPct: clamp(70 + Math.random() * 28, 0, 100) };
      s.run = null;
    } else {
      s.run = run;
    }
  }

  // --- Oven idle drift + batch (UpdateBatch) ---
  const idleTarget = power > 0 ? 82 : 24;
  if (s.stage !== 'baking') {
    s.ovenTemperatureC += (idleTarget - s.ovenTemperatureC) * Math.min(1, seconds / 16.0);
  }

  if (s.stage !== 'idle') {
    let stageRate = power * clamp(s.lineSpeed, 0.15, 1.25);
    if (s.stage === 'baking') {
      s.ovenTemperatureC += (r.ovenSetpointC - s.ovenTemperatureC) * Math.min(1, (seconds * power) / 10.0);
      const heatTransfer = Math.max(0, (s.ovenTemperatureC - s.batchInternalC) / Math.max(40, r.ovenSetpointC));
      s.batchInternalC += seconds * heatTransfer * 7.0 * power;
      if (s.ovenTemperatureC < r.ovenSetpointC - 25) stageRate *= 0.35;
    } else if (s.stage === 'mixing') {
      s.mixerSpecificGravity += (r.targetSpecificGravity - s.mixerSpecificGravity) * Math.min(1, (seconds * stageRate) / 6.0);
    } else if (s.stage === 'cooling') {
      s.batchInternalC += (32 - s.batchInternalC) * Math.min(1, (seconds * stageRate) / 16.0);
    }

    if (stageRate <= 0.01) {
      s.batchQuality = Math.max(55, s.batchQuality - seconds * 0.08);
    } else if (s.stageReady) {
      const holdPenalty = s.stage === 'baking' ? 0.18 : 0.035;
      s.batchQuality = Math.max(50, s.batchQuality - seconds * holdPenalty);
    } else {
      const duration = stageDuration(r, s.stage);
      s.stageSeconds = Math.min(duration, s.stageSeconds + seconds * stageRate);
      if (s.stageSeconds >= duration && stageSafetyGateMet(s)) s.stageReady = true;
    }
  }

  // Sanitation decay (from Tick).
  s.sanitationScore = clamp(
    s.sanitationScore - seconds * (0.003 + (s.stage === 'idle' ? 0 : 0.018 * s.lineSpeed)),
    0, 100,
  );

  return s;
}

// ---------------------------------------------------------------------------
// Action handlers that mutate state immediately (button clicks).
// ---------------------------------------------------------------------------

function doHarvest(prev: SimState): SimState {
  const s = { ...prev };
  if (s.powerAvailability < 0.15) return { ...s, message: 'errHarvestPower' };
  if (s.wheatGrowth < 25 && s.beetGrowth < 25 && s.vanillaGrowth < 25) return { ...s, message: 'errFieldsImmature' };
  let wheat = 0, beet = 0, vanilla = 0;
  if (s.wheatGrowth >= 25) { wheat = 3.8 * s.wheatGrowth; s.wheatKg += wheat; s.strawKg += wheat * 0.62; s.wheatGrowth = 12 + Math.random() * 8; }
  if (s.beetGrowth >= 25) { beet = 7.2 * s.beetGrowth; s.sugarCropKg += beet; s.beetGrowth = 10 + Math.random() * 8; }
  if (s.vanillaGrowth >= 25) { vanilla = 0.055 * s.vanillaGrowth; s.vanillaBeansKg += vanilla; s.vanillaGrowth = 8 + Math.random() * 5; }
  s.pastureHealth = Math.min(100, s.pastureHealth + 8);
  s.message = 'msgHarvested';
  return s;
}

function doCollect(prev: SimState): SimState {
  const s = { ...prev };
  if (s.powerAvailability < 0.12) return { ...s, message: 'errCollectPower' };
  if (s.dairyReadyL < 1 && s.eggsReady < 1) return { ...s, message: 'errBuffersEmpty' };
  const milk = Math.min(s.dairyReadyL, 36);
  const eggs = Math.min(s.eggsReady, 96);
  s.dairyReadyL -= milk;
  s.eggsReady -= eggs;
  s.rawMilkL += milk;
  s.eggs += eggs;
  if (eggs > 0) {
    s.processWaterL = Math.max(0, s.processWaterL - 8);
    s.compressedAirNm3 = Math.max(0, s.compressedAirNm3 - 2);
    s.filterMediaPct = Math.max(0, s.filterMediaPct - 0.05);
  }
  s.message = 'msgCollected';
  return s;
}

function doFactory(prev: SimState, kind: FactoryKind): SimState {
  const s = { ...prev };
  const spec = FACTORY_SPECS[kind];
  if (s.powerAvailability < 0.2) return { ...s, message: 'errFactoryPower' };
  if (s.run) return { ...s, message: 'errFactoryBusy' };
  if (s.pendingLab) return { ...s, message: 'errLabPending' };
  if (!hasUtilities(s, spec.processWaterL, spec.culinarySteamKg, spec.compressedAirNm3, spec.filterMediaPct)) {
    return { ...s, message: 'errFactoryUtilities' };
  }
  const built = spec.build(s);
  if ('error' in built) return { ...s, message: built.error };

  // Consume inputs + utilities and start the run.
  const draft = s;
  built.consume(draft);
  draft.processWaterL = Math.max(0, draft.processWaterL - spec.processWaterL);
  draft.culinarySteamKg = Math.max(0, draft.culinarySteamKg - spec.culinarySteamKg);
  draft.compressedAirNm3 = Math.max(0, draft.compressedAirNm3 - spec.compressedAirNm3);
  draft.filterMediaPct = Math.max(0, draft.filterMediaPct - spec.filterMediaPct);
  draft.run = {
    kind, name: spec.nameKey, duration: spec.duration, elapsed: 0, powerMW: spec.powerMW,
    product: built.product, waste: built.waste,
    processWaterL: spec.processWaterL, culinarySteamKg: spec.culinarySteamKg,
    compressedAirNm3: spec.compressedAirNm3, filterMediaPct: spec.filterMediaPct,
    outputField: spec.outputField,
  };
  draft.message = 'msgFactoryStarted';
  return draft;
}

function doReleaseLab(prev: SimState): SimState {
  const s = { ...prev };
  if (s.powerAvailability < 0.15) return { ...s, message: 'errLabPower' };
  if (!s.pendingLab) return { ...s, message: 'errLabEmpty' };
  if (!hasUtilities(s, 12, 0, 4, 0.1)) return { ...s, message: 'errLabUtilities' };
  s.processWaterL = Math.max(0, s.processWaterL - 12);
  s.compressedAirNm3 = Math.max(0, s.compressedAirNm3 - 4);
  s.filterMediaPct = Math.max(0, s.filterMediaPct - 0.1);
  s.message = s.pendingLab.qualityPct < 62 ? 'msgLabRejected' : 'msgLabReleased';
  s.pendingLab = null;
  return s;
}

function doClean(prev: SimState): SimState {
  const s = { ...prev };
  s.cipSeconds = Math.max(s.cipSeconds, 24);
  if (s.stage === 'idle') s.stageSeconds = 0;
  s.message = 'msgCipStarted';
  return s;
}

function doStageKit(prev: SimState): SimState {
  const s = { ...prev };
  const r = currentRecipe(s);
  if (s.stage !== 'idle') return { ...s, message: 'errBatchOnLine' };
  if (s.cipSeconds > 0) return { ...s, message: 'errCipActive' };
  if (s.powerAvailability < 0.2) return { ...s, message: 'errStagePower' };
  if (s.batchKitStaged) return { ...s, message: 'errKitStaged' };
  if (s.forkliftBatteryPct < 12) return { ...s, message: 'errForklift' };
  if (s.warehousePalletSpacePct < 18) return { ...s, message: 'errPalletSpace' };
  if (missingIngredients(s, r).length > 0) return { ...s, message: 'errMissingIngredients' };

  const icingNeed = icingNeedKg(r);
  const n = r.batchSize;
  s.flourKg = Math.max(0, s.flourKg - r.flourKg * n);
  s.sugarKg = Math.max(0, s.sugarKg - r.sugarKg * n);
  s.eggs = Math.max(0, s.eggs - r.eggCount * n);
  s.butterKg = Math.max(0, s.butterKg - r.butterKg * n);
  s.milkL = Math.max(0, s.milkL - r.milkL * n);
  s.bakingPowderKg = Math.max(0, s.bakingPowderKg - r.bakingPowderKg * n);
  s.saltKg = Math.max(0, s.saltKg - r.saltKg * n);
  s.vanillaL = Math.max(0, s.vanillaL - r.vanillaL * n);
  s.cocoaKg = Math.max(0, s.cocoaKg - r.cocoaKg * n);
  s.icingKg = Math.max(0, s.icingKg - icingNeed);
  s.packagingUnits = Math.max(0, s.packagingUnits - n);

  s.batchKitMassKg = batchIngredientMass(r) + icingNeed;
  s.forkliftBatteryPct = Math.max(0, s.forkliftBatteryPct - clamp(5 + s.batchKitMassKg * 0.1, 5, 14));
  s.warehousePalletSpacePct = Math.max(0, s.warehousePalletSpacePct - 8);
  s.batchKitStaged = true;
  s.batchKitRecipeKey = r.key;
  s.message = 'msgKitStaged';
  return s;
}

function doStartBatch(prev: SimState): SimState {
  const s = { ...prev };
  const r = currentRecipe(s);
  if (s.stage !== 'idle') return { ...s, message: 'errBatchOnLine' };
  if (s.cipSeconds > 0) return { ...s, message: 'errCipActive' };
  if (s.powerAvailability < 0.2) return { ...s, message: 'errBatchPower' };
  if (!s.batchKitStaged) return { ...s, message: 'errNoKit' };
  if (s.batchKitRecipeKey !== r.key) return { ...s, message: 'errKitWrongRecipe' };

  s.stage = 'scaling';
  s.stageReady = false;
  s.stageSeconds = 0;
  s.batchInternalC = 22;
  s.mixerSpecificGravity = 1.02;
  s.batchQuality = clamp(86 + s.sanitationScore * 0.11 + Math.random() * 4, 70, 99);
  s.warehousePalletSpacePct = Math.min(100, s.warehousePalletSpacePct + 6);
  s.batchKitStaged = false;
  s.batchKitRecipeKey = '';
  s.batchKitMassKg = 0;
  s.message = 'msgBatchStarted';
  return s;
}

function doAdvance(prev: SimState): SimState {
  const s = { ...prev };
  if (s.stage === 'idle') return { ...s, message: 'errNoBatch' };
  if (!s.stageReady) return { ...s, message: 'errStageRunning' };
  if (s.powerAvailability < 0.2) return { ...s, message: 'errAdvancePower' };
  if (!stageSafetyGateMet(s)) return { ...s, message: 'errSafetyGate' };

  const advanceTo = nextStage(s.stage);
  s.stageReady = false;
  s.stageSeconds = 0;
  if (advanceTo === 'idle') {
    // CompleteBatch.
    const r = currentRecipe(s);
    const quality = liveQuality(s, s.powerAvailability);
    const pass = clamp((quality - 62) / 34.0, 0.15, 0.995);
    const packed = Math.round(r.batchSize * pass);
    const rejected = r.batchSize - packed;
    s.cakesBaked += r.batchSize;
    s.cakesPacked += packed;
    s.cakesRejected += rejected;
    s.finishedGoodsCakes += packed;
    s.sanitationScore = Math.max(0, s.sanitationScore - 2.4);
    s.batchInternalC = 28;
    s.stage = 'idle';
    s.message = 'msgBatchComplete';
  } else {
    s.stage = advanceTo;
    s.message = 'msgStageReleased';
  }
  return s;
}

function doOrderSupply(prev: SimState): SimState {
  const s = { ...prev };
  if (s.powerAvailability < 0.1) return { ...s, message: 'errSupplyPower' };
  if (s.supplyEnRoute) return { ...s, message: 'errSupplyEnRoute' };
  if (s.cashBalance < s.supplyOrderCost) return { ...s, message: 'errSupplyCash' };
  s.cashBalance -= s.supplyOrderCost;
  s.supplyEtaSeconds = 42 + Math.random() * 18;
  s.supplyEnRoute = true;
  s.supplyArrived = false;
  s.message = 'msgSupplyOrdered';
  return s;
}

function doUnloadSupply(prev: SimState): SimState {
  const s = { ...prev };
  if (s.powerAvailability < 0.1) return { ...s, message: 'errUnloadPower' };
  if (!s.supplyEnRoute || !s.supplyArrived) return { ...s, message: 'errNoTruck' };
  if (s.forkliftBatteryPct < 8 || s.warehousePalletSpacePct < 8) return { ...s, message: 'errUnloadCapacity' };
  // ApplySupplyManifest (consolidated to the resources this port tracks).
  s.wheatKg += 260;
  s.strawKg += 260;
  s.brineL += 1600;
  s.sodaAshKg += 42;
  s.cocoaBeansKg += 90;
  s.processWaterL = Math.min(PROCESS_WATER_CAP, s.processWaterL + 9000);
  s.culinarySteamKg = Math.min(CULINARY_STEAM_CAP, s.culinarySteamKg + 2200);
  s.compressedAirNm3 = Math.min(COMPRESSED_AIR_CAP, s.compressedAirNm3 + 720);
  s.filterMediaPct = Math.min(100, s.filterMediaPct + 45);
  s.packagingUnits += 60;
  s.forkliftBatteryPct = Math.max(0, s.forkliftBatteryPct - 4.5);
  s.warehousePalletSpacePct = Math.max(0, s.warehousePalletSpacePct - 2.0);
  s.supplyEnRoute = false;
  s.supplyArrived = false;
  s.supplyEtaSeconds = 0;
  s.message = 'msgSupplyUnloaded';
  return s;
}

function doDispatch(prev: SimState): SimState {
  const s = { ...prev };
  if (s.powerAvailability < 0.15) return { ...s, message: 'errDispatchPower' };
  if (s.finishedGoodsCakes < s.orderCakesRequired) return { ...s, message: 'errDispatchShort' };
  if (s.dispatchTruckChargePct < 18) return { ...s, message: 'errDispatchCharge' };
  if (s.dispatchColdChainC > 8.0) return { ...s, message: 'errDispatchWarm' };

  const deadlineFactor = s.orderSecondsRemaining >= 0 ? 1.0 : 0.72;
  const qualityFactor = clamp(liveQuality(s, s.powerAvailability) / 100.0, 0.55, 1.05);
  const paid = Math.round(s.orderReward * deadlineFactor * qualityFactor * 100) / 100;
  s.finishedGoodsCakes -= s.orderCakesRequired;
  s.cashBalance += paid;
  s.dispatchTruckChargePct = Math.max(0, s.dispatchTruckChargePct - 10 - s.orderCakesRequired * 0.18);
  s.reputationPct = clamp(s.reputationPct + (s.orderSecondsRemaining >= 0 ? 2.8 : -4.5) + (qualityFactor - 0.82) * 3.0, 0, 100);
  s.ordersFulfilled += 1;
  // CreateNextOrder.
  s.orderSequence += 1;
  s.currentOrderId = `ORD-${String(s.orderSequence).padStart(6, '0')}`;
  s.orderCakesRequired = currentRecipe(s).batchSize + (s.ordersFulfilled % 3) * 4;
  s.orderSecondsRemaining = 360 + s.orderCakesRequired * 8;
  s.orderReward = 18.0 * s.orderCakesRequired + Math.max(0, s.reputationPct - 70) * 1.5;
  s.message = 'msgDispatched';
  return s;
}

function reducer(state: SimState, action: Action): SimState {
  switch (action.t) {
    case 'tick': return state.running ? step(state, action.dt) : state;
    case 'toggleRun': return { ...state, running: !state.running };
    case 'setRecipe': return { ...state, recipeIndex: clamp(action.i, 0, RECIPES.length - 1) };
    case 'setFarm': return { ...state, farmIntensity: clamp(action.v, 0, 1) };
    case 'setLine': return { ...state, lineSpeed: clamp(action.v, 0, 1) };
    case 'setAutoHarvest': return { ...state, autoHarvest: action.v };
    case 'toggleReactor': return { ...state, reactorOnline: !state.reactorOnline };
    case 'setReactorMW': return { ...state, reactorSetMW: clamp(action.v, 0, 120) };
    case 'harvest': return doHarvest(state);
    case 'collect': return doCollect(state);
    case 'factory': return doFactory(state, action.kind);
    case 'releaseLab': return doReleaseLab(state);
    case 'clean': return doClean(state);
    case 'stageKit': return doStageKit(state);
    case 'startBatch': return doStartBatch(state);
    case 'advance': return doAdvance(state);
    case 'orderSupply': return doOrderSupply(state);
    case 'unloadSupply': return doUnloadSupply(state);
    case 'dispatch': return doDispatch(state);
    default: return state;
  }
}

// ---------------------------------------------------------------------------
// UI helpers.
// ---------------------------------------------------------------------------

function Gauge({ label, pct, value, tone }: { label: string; pct: number; value: string; tone?: string }) {
  const w = clamp(pct, 0, 100);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <span style={{ opacity: 0.75 }}>{label}</span>
        <span style={{ fontWeight: 600 }}>{value}</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'rgba(128,128,128,0.22)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${w}%`, background: tone ?? '#4a90d9', transition: 'width 0.2s linear' }} />
      </div>
    </div>
  );
}

const STAGE_KEYS: Record<Stage, string> = {
  idle: 'stageIdle', scaling: 'stageScaling', mixing: 'stageMixing', depositing: 'stageDepositing',
  baking: 'stageBaking', cooling: 'stageCooling', icing: 'stageIcing', packaging: 'stagePackaging',
};

export function CakeFactoryModule() {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const lastRef = useRef<number>(performance.now());

  useEffect(() => {
    if (!state.running) return;
    lastRef.current = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - lastRef.current) / 1000;
      lastRef.current = now;
      dispatch({ t: 'tick', dt });
    }, 200);
    return () => window.clearInterval(id);
  }, [state.running]);

  const r = currentRecipe(state);
  const power = state.powerAvailability;
  const demand = useMemo(() => powerDemand(state), [state]);
  const quality = liveQuality(state, power);
  const missing = missingIngredients(state, r);
  const runProgress = state.run ? (state.run.elapsed / state.run.duration) * 100 : 0;
  const stageProg = state.stage === 'idle' ? 0 : (state.stageSeconds / stageDuration(r, state.stage)) * 100;
  const coreProg = clamp((state.batchInternalC / 71) * 100, 0, 100);
  const cipProg = state.cipSeconds > 0 ? (1 - state.cipSeconds / 24) * 100 : 100;

  const canStage = state.stage === 'idle' && state.cipSeconds <= 0 && !state.batchKitStaged
    && missing.length === 0 && power >= 0.2 && state.forkliftBatteryPct >= 12 && state.warehousePalletSpacePct >= 18;
  const canStart = state.stage === 'idle' && state.cipSeconds <= 0 && state.batchKitStaged
    && state.batchKitRecipeKey === r.key && power >= 0.2;
  const canAdvance = state.stage !== 'idle' && state.stageReady && power >= 0.2 && stageSafetyGateMet(state);
  const canDispatch = power >= 0.15 && state.finishedGoodsCakes >= state.orderCakesRequired
    && state.dispatchTruckChargePct >= 18 && state.dispatchColdChainC <= 8.0;

  const powerTone = power >= 0.98 ? '#3fb950' : power >= 0.4 ? '#d9a441' : '#d9534f';
  const msg = state.message ? t(`cakefactory.${state.message}`) : '';

  return (
    <div className="mod">
      <p className="count-note" style={{ marginTop: 0 }}>{t('cakefactory.blurb')}</p>

      {/* Reactor bus + run controls */}
      <div className="panel" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: 12 }}>
        <button className="mini" onClick={() => dispatch({ t: 'toggleRun' })}>
          {state.running ? t('cakefactory.pause') : t('cakefactory.resume')}
        </button>
        <label className="chk">
          <input type="checkbox" checked={state.reactorOnline} onChange={() => dispatch({ t: 'toggleReactor' })} />
          {t('cakefactory.reactorOnline')}
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 220 }}>
          <span className="count-note" style={{ margin: 0 }}>{t('cakefactory.reactorSetpoint')}</span>
          <input
            type="range" min={0} max={120} step={1} value={state.reactorSetMW}
            onChange={(e) => dispatch({ t: 'setReactorMW', v: +e.target.value })}
            style={{ flex: 1 }}
          />
          <span style={{ fontWeight: 600, minWidth: 60 }}>{state.reactorSetMW.toFixed(0)} MWe</span>
        </div>
        <span className="status-pill" style={{ background: powerTone, color: '#fff' }}>
          {t('cakefactory.busLoad', { pct: (power * 100).toFixed(0), mw: state.reactorMW.toFixed(1), demand: demand.toFixed(1) })}
        </span>
      </div>

      {msg && <p className="count-note" style={{ marginTop: 8 }}>{msg}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginTop: 12 }}>
        {/* Controls card */}
        <div className="kv-list panel" style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>{t('cakefactory.controlsTitle')}</h3>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="count-note" style={{ margin: 0 }}>{t('cakefactory.recipe')}</span>
            <select className="mod-select" value={state.recipeIndex} onChange={(e) => dispatch({ t: 'setRecipe', i: +e.target.value })}>
              {RECIPES.map((rc, i) => (
                <option key={rc.key} value={i}>{t(`cakefactory.recipe_${rc.key}`)}</option>
              ))}
            </select>
          </label>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="count-note" style={{ margin: 0 }}>{t('cakefactory.farmIntensity')}</span>
              <span style={{ fontWeight: 600 }}>{(state.farmIntensity * 100).toFixed(0)}%</span>
            </div>
            <input type="range" min={0} max={100} step={1} value={Math.round(state.farmIntensity * 100)}
              onChange={(e) => dispatch({ t: 'setFarm', v: +e.target.value / 100 })} style={{ width: '100%' }} />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span className="count-note" style={{ margin: 0 }}>{t('cakefactory.lineSpeed')}</span>
              <span style={{ fontWeight: 600 }}>{(state.lineSpeed * 100).toFixed(0)}%</span>
            </div>
            <input type="range" min={0} max={120} step={1} value={Math.round(state.lineSpeed * 100)}
              onChange={(e) => dispatch({ t: 'setLine', v: +e.target.value / 100 })} style={{ width: '100%' }} />
          </div>
          <label className="chk">
            <input type="checkbox" checked={state.autoHarvest} onChange={(e) => dispatch({ t: 'setAutoHarvest', v: e.target.checked })} />
            {t('cakefactory.autoHarvest')}
          </label>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button className="mini" onClick={() => dispatch({ t: 'harvest' })}>{t('cakefactory.harvest')}</button>
            <button className="mini" onClick={() => dispatch({ t: 'collect' })}>{t('cakefactory.collect')}</button>
            <button className="mini" onClick={() => dispatch({ t: 'clean' })}>{t('cakefactory.clean')}</button>
            <button className="mini" onClick={() => dispatch({ t: 'orderSupply' })} disabled={state.supplyEnRoute}>{t('cakefactory.orderSupply')}</button>
            <button className="mini" onClick={() => dispatch({ t: 'unloadSupply' })} disabled={!state.supplyArrived}>{t('cakefactory.unloadSupply')}</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="count-note" style={{ margin: 0 }}>{t('cakefactory.factoriesTitle')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {FACTORY_BUTTONS.map((k) => (
                <button key={k} className="mini" disabled={!!state.run || !!state.pendingLab}
                  onClick={() => dispatch({ t: 'factory', kind: k })}>
                  {t(`cakefactory.${FACTORY_SPECS[k].nameKey}`)}
                </button>
              ))}
            </div>
          </div>

          <button className="mini" disabled={!state.pendingLab} onClick={() => dispatch({ t: 'releaseLab' })}>
            {t('cakefactory.releaseLab')}
          </button>
        </div>

        {/* Factory status card */}
        <div className="kv-list panel" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14 }}>
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>{t('cakefactory.statusTitle')}</h3>
          <div className="kv-row"><span className="dt">{t('cakefactory.stage')}</span>
            <span style={{ fontWeight: 600 }}>{t(`cakefactory.${STAGE_KEYS[state.stage]}`)}{state.stageReady ? ` · ${t('cakefactory.releaseReady')}` : ''}</span></div>
          <div className="kv-row"><span className="dt">{t('cakefactory.quality')}</span><span style={{ fontWeight: 600 }}>{quality.toFixed(0)}%</span></div>
          <div className="kv-row"><span className="dt">{t('cakefactory.sanitation')}</span><span style={{ fontWeight: 600 }}>{state.sanitationScore.toFixed(0)}%</span></div>
          <div className="kv-row"><span className="dt">{t('cakefactory.oven')}</span><span style={{ fontWeight: 600 }}>{state.ovenTemperatureC.toFixed(0)}°C · {t('cakefactory.core')} {state.batchInternalC.toFixed(0)}°C</span></div>
          <div className="kv-row"><span className="dt">{t('cakefactory.packed')}</span><span style={{ fontWeight: 600 }}>{state.cakesPacked} / {state.cakesBaked}</span></div>

          <Gauge label={t('cakefactory.stageProgress')} pct={stageProg} value={`${stageProg.toFixed(0)}%`} />
          <Gauge label={t('cakefactory.coreGate')} pct={coreProg} value={`${state.batchInternalC.toFixed(0)}°C`} tone="#d9843b" />
          <Gauge label={t('cakefactory.cipProgress')} pct={cipProg} value={state.cipSeconds > 0 ? `${cipProg.toFixed(0)}%` : t('cakefactory.ready')} tone="#3fb0d9" />

          {state.run && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="count-note" style={{ margin: 0 }}>
                {t('cakefactory.running', { name: t(`cakefactory.${state.run.name}`), pct: runProgress.toFixed(0), mw: state.run.powerMW.toFixed(1) })}
              </span>
              <Gauge label={t('cakefactory.factoryRun')} pct={runProgress} value={`${runProgress.toFixed(0)}%`} tone="#9a6fd9" />
            </div>
          )}
          {state.pendingLab && (
            <span className="status-pill" style={{ background: '#d9a441', color: '#fff' }}>
              {t('cakefactory.labHolding', { product: t(`cakefactory.fac_${state.pendingLab.product}`), pct: state.pendingLab.qualityPct.toFixed(0) })}
            </span>
          )}
          <span className="count-note" style={{ margin: 0 }}>
            {missing.length === 0 ? t('cakefactory.inputsStocked') : t('cakefactory.missing', { list: missing.map((m) => t(`cakefactory.ing_${m}`)).join(', ') })}
          </span>
        </div>

        {/* Batch line card */}
        <div className="kv-list panel" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14 }}>
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>{t('cakefactory.lineTitle')}</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="mini" disabled={!canStage} onClick={() => dispatch({ t: 'stageKit' })}>{t('cakefactory.stageKit')}</button>
            <button className="mini" disabled={!canStart} onClick={() => dispatch({ t: 'startBatch' })}>{t('cakefactory.startBatch')}</button>
            <button className="mini" disabled={!canAdvance} onClick={() => dispatch({ t: 'advance' })}>{t('cakefactory.advance')}</button>
          </div>
          {state.batchKitStaged && (
            <span className="count-note" style={{ margin: 0 }}>
              {t('cakefactory.kitStagedNote', { mass: state.batchKitMassKg.toFixed(1), recipe: t(`cakefactory.recipe_${state.batchKitRecipeKey}`) })}
            </span>
          )}
          <Gauge label={t('cakefactory.forklift')} pct={state.forkliftBatteryPct} value={`${state.forkliftBatteryPct.toFixed(0)}%`} tone="#3fb950" />
          <Gauge label={t('cakefactory.palletSpace')} pct={state.warehousePalletSpacePct} value={`${state.warehousePalletSpacePct.toFixed(0)}%`} tone="#3fb950" />
          <div className="kv-row"><span className="dt">{t('cakefactory.recipeBatch')}</span><span style={{ fontWeight: 600 }}>{r.batchSize} {t('cakefactory.cakes')}</span></div>
        </div>

        {/* Ingredient / farm inventory */}
        <div className="kv-list panel" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 14 }}>
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>{t('cakefactory.inventoryTitle')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px 12px', fontSize: 13 }}>
            <span>{t('cakefactory.ing_flour')}: {state.flourKg.toFixed(0)}kg</span>
            <span>{t('cakefactory.ing_sugar')}: {state.sugarKg.toFixed(0)}kg</span>
            <span>{t('cakefactory.ing_eggs')}: {state.eggs.toFixed(0)}</span>
            <span>{t('cakefactory.ing_milk')}: {state.milkL.toFixed(0)}L</span>
            <span>{t('cakefactory.ing_butter')}: {state.butterKg.toFixed(0)}kg</span>
            <span>{t('cakefactory.ing_cocoa')}: {state.cocoaKg.toFixed(0)}kg</span>
            <span>{t('cakefactory.ing_vanilla')}: {state.vanillaL.toFixed(1)}L</span>
            <span>{t('cakefactory.ing_salt')}: {state.saltKg.toFixed(0)}kg</span>
            <span>{t('cakefactory.ing_bakingPowder')}: {state.bakingPowderKg.toFixed(0)}kg</span>
            <span>{t('cakefactory.ing_icing')}: {state.icingKg.toFixed(1)}kg</span>
            <span>{t('cakefactory.ing_cartons')}: {state.packagingUnits.toFixed(0)}</span>
            <span>{t('cakefactory.rawMilk')}: {state.rawMilkL.toFixed(0)}L</span>
          </div>
          <hr style={{ border: 0, borderTop: '1px solid rgba(128,128,128,0.2)', margin: '4px 0' }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, fontSize: 12 }}>
            <Gauge label={t('cakefactory.wheat')} pct={state.wheatGrowth} value={`${state.wheatGrowth.toFixed(0)}%`} tone="#c9a227" />
            <Gauge label={t('cakefactory.beet')} pct={state.beetGrowth} value={`${state.beetGrowth.toFixed(0)}%`} tone="#c9a227" />
            <Gauge label={t('cakefactory.vanillaCrop')} pct={state.vanillaGrowth} value={`${state.vanillaGrowth.toFixed(0)}%`} tone="#8a6d3b" />
            <Gauge label={t('cakefactory.cocoaCrop')} pct={state.cocoaGrowth} value={`${state.cocoaGrowth.toFixed(0)}%`} tone="#8a6d3b" />
          </div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            {t('cakefactory.buffers', { milk: state.dairyReadyL.toFixed(0), eggs: state.eggsReady.toFixed(0) })}
          </div>
        </div>

        {/* Utilities */}
        <div className="kv-list panel" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14 }}>
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>{t('cakefactory.utilitiesTitle')}</h3>
          <Gauge label={t('cakefactory.processWater')} pct={(state.processWaterL / PROCESS_WATER_CAP) * 100} value={`${state.processWaterL.toFixed(0)} L`} tone="#3fb0d9" />
          <Gauge label={t('cakefactory.steam')} pct={(state.culinarySteamKg / CULINARY_STEAM_CAP) * 100} value={`${state.culinarySteamKg.toFixed(0)} kg`} tone="#d9843b" />
          <Gauge label={t('cakefactory.air')} pct={(state.compressedAirNm3 / COMPRESSED_AIR_CAP) * 100} value={`${state.compressedAirNm3.toFixed(0)} Nm³`} />
          <Gauge label={t('cakefactory.filter')} pct={state.filterMediaPct} value={`${state.filterMediaPct.toFixed(0)}%`} />
          {state.supplyEnRoute && (
            <span className="count-note" style={{ margin: 0 }}>
              {state.supplyArrived
                ? t('cakefactory.truckArrived')
                : t('cakefactory.truckEnRoute', { eta: state.supplyEtaSeconds.toFixed(0) })}
            </span>
          )}
        </div>

        {/* Orders / economy */}
        <div className="kv-list panel" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14 }}>
          <h3 className="group-title" style={{ fontSize: 15, margin: 0 }}>{t('cakefactory.ordersTitle')}</h3>
          <div className="kv-row"><span className="dt">{t('cakefactory.cash')}</span><span style={{ fontWeight: 600 }}>${state.cashBalance.toFixed(2)}</span></div>
          <div className="kv-row"><span className="dt">{t('cakefactory.reputation')}</span><span style={{ fontWeight: 600 }}>{state.reputationPct.toFixed(0)}%</span></div>
          <div className="kv-row"><span className="dt">{t('cakefactory.ordersFilled')}</span><span style={{ fontWeight: 600 }}>{state.ordersFulfilled}</span></div>
          <div className="kv-row"><span className="dt">{t('cakefactory.finishedGoods')}</span><span style={{ fontWeight: 600 }}>{state.finishedGoodsCakes}</span></div>
          <span className="count-note" style={{ margin: 0 }}>
            {t('cakefactory.orderLine', {
              id: state.currentOrderId,
              have: state.finishedGoodsCakes,
              need: state.orderCakesRequired,
              secs: state.orderSecondsRemaining.toFixed(0),
              reward: state.orderReward.toFixed(0),
            })}
          </span>
          <Gauge label={t('cakefactory.truckCharge')} pct={state.dispatchTruckChargePct} value={`${state.dispatchTruckChargePct.toFixed(0)}%`} tone="#3fb950" />
          <div className="kv-row"><span className="dt">{t('cakefactory.coldChain')}</span>
            <span style={{ fontWeight: 600, color: state.dispatchColdChainC > 8 ? '#d9534f' : undefined }}>{state.dispatchColdChainC.toFixed(1)}°C</span></div>
          <button className="mini" disabled={!canDispatch} onClick={() => dispatch({ t: 'dispatch' })}>{t('cakefactory.dispatch')}</button>
        </div>
      </div>
    </div>
  );
}
