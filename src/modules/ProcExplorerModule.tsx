import { ModuleTabs } from './ModuleTabs';
import { ProcessesModule } from './ProcessesModule';
import { ServicesModule } from './ServicesModule';

// WinForge's Process Explorer has Processes + Services sub-tabs; this composes the two
// real modules under the shared sub-tab shell.
export function ProcExplorerModule() {
  return (
    <ModuleTabs
      tabs={[
        { id: 'processes', en: 'Processes', zh: '程序', render: () => <ProcessesModule /> },
        { id: 'services', en: 'Services', zh: '服務', render: () => <ServicesModule /> },
      ]}
    />
  );
}
