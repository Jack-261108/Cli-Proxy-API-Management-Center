// Fork-local assertions on page implementation text; upstream has no such file, kept separate to avoid conflicts on every sync.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

describe('logs page', () => {
  const source = read('src/features/logs/LogsPage.tsx');

  test('the error-log caveat is an InfoTip on the tab card title', () => {
    expect(source).toMatch(
      /\{t\('logs\.error_logs_modal_title'\)\}\s*<InfoTip\s+content=\{t\('logs\.error_logs_description'\)\}/
    );
    expect(source).not.toContain(`<div className="hint">{t('logs.error_logs_description')}</div>`);
    // The "request logging is on, so this list stays empty" warning remains visible.
    expect(source).toContain("{t('logs.error_logs_request_log_enabled')}");
  });

  test('the raw-log explanation moved from a title to an InfoTip beside the switch', () => {
    expect(source).not.toMatch(/title=\{t\('logs\.show_raw_logs_hint'/);
    // A sibling of the switch, not inside its <label>.
    expect(source).toMatch(
      /checked=\{showRawLogs\}[\s\S]*?<\/span>\s*\}\s*\/>\s*<InfoTip\s+content=\{t\('logs\.show_raw_logs_hint'/
    );
  });
});

describe('plugins page', () => {
  test('the page header keeps its title and description; warnings stay', () => {
    const page = read('src/features/plugins/PluginsPage.tsx');
    expect(page).toMatch(
      /<h1 className=\{styles\.title\}>\{t\('plugin_management\.title'\)\}<\/h1>/
    );
    expect(page).toContain("t('plugin_management.description')");
    expect(page).toContain("t('plugin_management.global_disabled_hint')");
  });
});

describe('main layout', () => {
  test('the sidebar brand is the mark alone; the full name stays in its title', () => {
    const layout = read('src/components/layout/MainLayout.tsx');
    expect(layout).toMatch(
      /<span className="sidebar-brand-text">\s*<span className="sidebar-brand-title">\{abbrBrandName\}<\/span>\s*<\/span>/
    );
    expect(layout).toContain('className="sidebar-brand" title={fullBrandName}');
  });
});
