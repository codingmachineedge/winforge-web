// English UI strings. Module titles themselves live in the catalog (per-module en/zh).
export const en = {
  app: {
    title: 'WinForge Web',
    subtitle: 'Module catalog & reactor simulator',
    tagline: 'A web rewrite of the WinForge desktop suite.',
  },
  nav: {
    search: 'Search modules…',
    sections: 'Sections',
    allModules: 'All Modules',
    reactor: 'Nuclear Reactor',
    about: 'About',
    language: 'Language',
  },
  catalog: {
    heading: 'Module Catalog',
    count_one: '{{count}} module',
    count_other: '{{count}} modules',
    resultsFor: 'Results for “{{query}}”',
    noResults: 'No modules match your search.',
    native: 'Native only',
    web: 'Web port',
    open: 'Open',
    filterAll: 'All',
    filterWeb: 'Web-capable',
    filterNative: 'Native-only',
  },
  detail: {
    back: 'Back to catalog',
    tag: 'Page tag',
    keywords: 'Keywords',
    section: 'Section',
    group: 'Group',
    nativeTitle: 'Native-only module',
    nativeBody:
      'This module drives Windows system features (registry, services, native tools, hardware) and cannot run in a browser. In the web build it is shown as a labelled stub. Run the WinForge desktop app for full functionality.',
    webTitle: 'Web-portable module',
    webBody:
      'This module is pure client-side computation and is a candidate for a full web port. A working implementation is planned for the web build.',
    openReactor: 'Open the reactor simulator',
  },
  reactor: {
    title: 'PWR Reactor Simulator',
    subtitle: 'Point-kinetics core physics, ported from WinForge’s reactor engine.',
    comingSoon: 'The physics engine port is in progress on a dedicated branch.',
    power: 'Thermal power',
    reactivity: 'Reactivity',
    fuelTemp: 'Fuel temperature',
    coolantTemp: 'Coolant temperature',
    rods: 'Control rods',
    scram: 'SCRAM',
    start: 'Start',
    pause: 'Pause',
    reset: 'Reset',
  },
  about: {
    title: 'About WinForge Web',
    body:
      'WinForge Web is a React + TypeScript (Vite) rewrite of WinForge, a WinUI 3 / .NET desktop suite with 314 modules headlined by a physics-based PWR nuclear reactor simulator. Native-only modules are rendered as clearly-labelled UI stubs.',
    source: 'Source module count derived from WinForge’s ModuleRegistry and MainWindow navigation.',
  },
  footer: {
    builtWith: 'React · TypeScript · Vite',
  },
};

export type Resources = typeof en;
