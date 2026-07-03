import { ReactorView } from '../components/ReactorView';

// The flagship reactor simulator, surfaced as a catalog module so it opens
// inline like every other module. The full physics engine and control-room UI
// live in ReactorView (src/components/ReactorView.tsx + src/reactor/*).
export function ReactorModule() {
  return <ReactorView />;
}
