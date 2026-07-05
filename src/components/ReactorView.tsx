// 反應堆畫面 · The reactor route — now the Material-design-rewrite Control Room (full replace,
// per the design handoff): the CRT console IS the reactor screen. The protection/ESF engines
// (rod program, PORV/PRT, App-G/LTOP, SI/MSSV, containment, CSF trees, turbine) keep running
// inside useReactorSim/ReactorAux; their annunciators surface on the control-room alarm board.
//
// ReactorView is its own lazy route (App opens it via the `reactor` view kind, not always through
// ModuleDetail), so it must register the per-module i18n namespaces itself. Idempotent.

import { useReactorSim } from '../reactor/useReactorSim';
import { ControlRoom } from './reactor/controlRoom/ControlRoom';
import { registerModuleStrings } from '../i18n/moduleStrings';

registerModuleStrings();

export function ReactorView() {
  const sim = useReactorSim();
  return <ControlRoom sim={sim} />;
}
