import { describe, expect, test } from 'bun:test';
import { getPluginLogo } from '../src/features/plugins/pluginLogo';
import type { PluginListEntry } from '../src/types';

const plugin = (overrides: Partial<PluginListEntry> = {}) =>
  ({ id: 'example', logo: '', metadata: null, ...overrides }) as PluginListEntry;

describe('management plugin logos', () => {
  test('returns runtime logo when present', () => {
    expect(getPluginLogo(plugin({ logo: 'runtime.png' }))).toBe('runtime.png');
  });

  test('prefers runtime logo over metadata logo', () => {
    const metadata = {
      name: '',
      version: '',
      author: '',
      githubRepository: '',
      logo: 'metadata.png',
      configFields: [],
    };
    expect(getPluginLogo(plugin({ logo: 'runtime.png', metadata }))).toBe('runtime.png');
  });

  test('falls back to metadata logo when runtime logo is blank', () => {
    const metadata = {
      name: '',
      version: '',
      author: '',
      githubRepository: '',
      logo: 'metadata.png',
      configFields: [],
    };
    expect(getPluginLogo(plugin({ logo: '  ', metadata }))).toBe('metadata.png');
  });

  test('returns empty string when no logo is available', () => {
    expect(getPluginLogo(plugin())).toBe('');
  });
});
