import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isPluginsPageAvailable } from '../src/features/plugins/pluginAvailability';
import { normalizeConfigResponse } from '../src/services/api/transformers';

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('plugin page availability', () => {
  test('stays reachable while the configuration is still loading', () => {
    expect(isPluginsPageAvailable(null)).toBe(true);
    expect(isPluginsPageAvailable(undefined)).toBe(true);
  });

  test('is only offered when the plugin system is enabled', () => {
    expect(isPluginsPageAvailable({ pluginsEnabled: true })).toBe(true);
    expect(isPluginsPageAvailable({ pluginsEnabled: false })).toBe(false);
    expect(isPluginsPageAvailable({})).toBe(false);
  });

  test('normalizes the v8 plugins.enabled switch', () => {
    expect(normalizeConfigResponse({ plugins: { enabled: true } }).pluginsEnabled).toBe(true);
    expect(normalizeConfigResponse({ plugins: { enabled: false } }).pluginsEnabled).toBe(false);
    expect(normalizeConfigResponse({}).pluginsEnabled).toBeUndefined();
  });
});

describe('plugin page entry points', () => {
  test('the sidebar hides plugin management when the plugin system is disabled', () => {
    const layout = readSource('src/components/layout/MainLayout.tsx');
    expect(layout).toContain(
      'const showPluginsNav = useConfigStore((state) => isPluginsPageAvailable(state.config));'
    );
    expect(layout).toContain('...(supportsPlugin && showPluginsNav');
  });

  test('plugin resource navigation and loading follow the plugin system switch', () => {
    const layout = readSource('src/components/layout/MainLayout.tsx');
    expect(layout).toContain('!supportsPlugin || !showPluginsNav');
    expect(layout).toContain(
      'const pluginPageNavItems: SidebarNavItem[] = supportsPlugin && showPluginsNav'
    );
  });

  test('a direct plugins URL falls back to the dashboard when the plugin system is disabled', () => {
    const routes = readSource('src/router/MainRoutes.tsx');
    expect(routes).toContain(
      'const pluginsEnabled = useConfigStore((state) => isPluginsPageAvailable(state.config));'
    );
    expect(routes).toContain('const pluginsAvailable = supportsPlugin && pluginsEnabled;');
    expect(routes).toContain('pluginsAvailable ? <PluginsPage /> : <Navigate to="/" replace />');
    expect(routes).toContain("path: '/plugin-pages/:pluginId/:menuIndex'");
    expect(routes).toContain('{ path: \'/plugin-pages/*\', element: <Navigate to="/" replace /> }');
  });
});
