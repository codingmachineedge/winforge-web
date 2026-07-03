import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

// The registry pulls in prefs (persisted store), theme, and i18n — all of which
// read localStorage on import. Install an in-memory localStorage on globalThis
// BEFORE importing anything that touches it, then import lazily inside tests.

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  clear(): void {
    this.map.clear();
  }
}

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// A minimal translator: return the key itself. Good enough for identity/round-trip
// tests. Bilingual/translation matching is exercised with a custom `t` below.
const identityT = ((key: string) => key) as unknown as TFunction;

describe('settingsRegistry', () => {
  it('has unique ids', async () => {
    const { settingsRegistry } = await import('./settingsRegistry');
    const ids = settingsRegistry.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it('every def carries the required i18n + shape metadata', async () => {
    const { settingsRegistry } = await import('./settingsRegistry');
    for (const def of settingsRegistry) {
      expect(def.labelKey).toMatch(/^shellsettings\./);
      expect(def.descKey).toMatch(/^shellsettings\./);
      expect(def.categoryKey).toMatch(/^shellsettings\./);
      expect(typeof def.get).toBe('function');
      expect(typeof def.set).toBe('function');
      if (def.control === 'slider') {
        expect(typeof def.min).toBe('number');
        expect(typeof def.max).toBe('number');
      }
      if (def.control === 'select' || def.control === 'theme' || def.control === 'lang') {
        expect(Array.isArray(def.options)).toBe(true);
        expect(def.options!.length).toBeGreaterThan(0);
      }
    }
  });

  it('get()/set() round-trip against the real stores', async () => {
    const { settingsRegistry } = await import('./settingsRegistry');
    const byId = (id: string) => {
      const def = settingsRegistry.find((d) => d.id === id);
      if (!def) throw new Error(`no setting with id ${id}`);
      return def;
    };

    // theme (setThemeMode/getThemeMode)
    byId('theme').set('light');
    expect(byId('theme').get()).toBe('light');
    byId('theme').set('dark');
    expect(byId('theme').get()).toBe('dark');

    // viewMode (prefs)
    byId('viewMode').set('list');
    expect(byId('viewMode').get()).toBe('list');
    byId('viewMode').set('grid');
    expect(byId('viewMode').get()).toBe('grid');

    // density (prefs)
    byId('density').set('compact');
    expect(byId('density').get()).toBe('compact');

    // sidebarCollapsed (prefs, boolean)
    byId('sidebarCollapsed').set(true);
    expect(byId('sidebarCollapsed').get()).toBe(true);
    byId('sidebarCollapsed').set(false);
    expect(byId('sidebarCollapsed').get()).toBe(false);

    // uiScale (prefs, clamped)
    byId('uiScale').set(1.2);
    expect(byId('uiScale').get()).toBe(1.2);
    byId('uiScale').set(5); // clamped to max
    expect(byId('uiScale').get()).toBe(1.5);
  });

  it('lang setting round-trips through i18n', async () => {
    const { settingsRegistry } = await import('./settingsRegistry');
    const lang = settingsRegistry.find((d) => d.id === 'lang')!;
    lang.set('yue');
    expect(lang.get()).toBe('yue');
    lang.set('en');
    expect(lang.get()).toBe('en');
  });
});

describe('filterSettings', () => {
  it('returns all defs for an empty / blank query', async () => {
    const { settingsRegistry, filterSettings } = await import('./settingsRegistry');
    expect(filterSettings(settingsRegistry, '', identityT)).toHaveLength(settingsRegistry.length);
    expect(filterSettings(settingsRegistry, '   ', identityT)).toHaveLength(
      settingsRegistry.length,
    );
  });

  it('matches against the translated label text', async () => {
    const { settingsRegistry, filterSettings } = await import('./settingsRegistry');
    // A translator mapping the theme label key to real text; everything else empty.
    const t = ((key: string) =>
      key === 'shellsettings.themeLabel' ? 'Theme' : '') as unknown as TFunction;
    const res = filterSettings(settingsRegistry, 'theme', t);
    expect(res.map((d) => d.id)).toEqual(['theme']);
  });

  it('matches all whitespace-separated terms (AND semantics)', async () => {
    const { settingsRegistry, filterSettings } = await import('./settingsRegistry');
    const t = ((key: string) => {
      if (key === 'shellsettings.uiScaleLabel') return 'Interface scale';
      if (key === 'shellsettings.uiScaleDesc') return 'Zoom the whole interface';
      return '';
    }) as unknown as TFunction;
    expect(filterSettings(settingsRegistry, 'interface scale', t).map((d) => d.id)).toEqual([
      'uiScale',
    ]);
    // A term that appears nowhere kills the match.
    expect(filterSettings(settingsRegistry, 'interface nonexistentterm', t)).toHaveLength(0);
  });

  it('matches bilingual "EN · 粵" translated text', async () => {
    const { settingsRegistry, filterSettings } = await import('./settingsRegistry');
    const t = ((key: string) =>
      key === 'shellsettings.densityLabel' ? 'Density · 密度' : '') as unknown as TFunction;
    // English term hits.
    expect(filterSettings(settingsRegistry, 'density', t).map((d) => d.id)).toEqual(['density']);
    // Cantonese term in the same bilingual string also hits.
    expect(filterSettings(settingsRegistry, '密度', t).map((d) => d.id)).toEqual(['density']);
  });

  it('matches against option labels, including the raw LANGS lang labels', async () => {
    const { settingsRegistry, filterSettings } = await import('./settingsRegistry');
    // The lang option labels (EN / 粵語 / EN+粵) are NOT translated — they come
    // from LANGS via langOptionLabel — so searching "粵" should surface lang.
    const res = filterSettings(settingsRegistry, '粵', identityT);
    expect(res.map((d) => d.id)).toContain('lang');
  });
});
