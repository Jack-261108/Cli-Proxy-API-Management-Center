import type { PluginListEntry } from '@/types';

export const getPluginLogo = (plugin: PluginListEntry): string =>
  plugin.logo.trim() || plugin.metadata?.logo.trim() || '';
