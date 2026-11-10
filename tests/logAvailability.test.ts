import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isLogsPageAvailable } from '../src/features/logs/model/logAvailability';

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('log page availability', () => {
  test('stays reachable while the configuration is still loading', () => {
    expect(isLogsPageAvailable(null)).toBe(true);
    expect(isLogsPageAvailable(undefined)).toBe(true);
  });

  test('is only offered when file logging is enabled', () => {
    expect(isLogsPageAvailable({ loggingToFile: true })).toBe(true);
    expect(isLogsPageAvailable({ loggingToFile: false })).toBe(false);
    expect(isLogsPageAvailable({})).toBe(false);
  });
});

describe('log page entry points', () => {
  test('the sidebar hides the logs entry when file logging is disabled', () => {
    const layout = readSource('src/components/layout/MainLayout.tsx');
    expect(layout).toContain(
      'const showLogsNav = useConfigStore((state) => isLogsPageAvailable(state.config));'
    );
    expect(layout).toMatch(/\.\.\.\(showLogsNav\s*\?/);
  });

  test('a direct logs URL falls back to the dashboard when file logging is disabled', () => {
    const routes = readSource('src/router/MainRoutes.tsx');
    expect(routes).toContain('useConfigStore((state) => isLogsPageAvailable(state.config))');
    expect(routes).toContain('logsAvailable ? <LogsPage /> : <Navigate to="/" replace />');
  });

  test('dashboard log shortcuts follow the same availability rule', () => {
    const dashboard = readSource('src/features/dashboard/DashboardPage.tsx');
    expect(dashboard).toContain('const logsAvailable = isLogsPageAvailable(config);');
    expect(dashboard).toContain('logsAvailable && (');
  });
});
