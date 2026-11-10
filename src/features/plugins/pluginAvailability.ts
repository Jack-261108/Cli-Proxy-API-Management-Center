import type { Config } from '@/types';

/**
 * Plugin management only applies when the backend plugin system is enabled.
 * A missing config means it is still loading; keep the page reachable instead
 * of hiding navigation on an unknown state.
 */
export function isPluginsPageAvailable(
  config: Pick<Config, 'pluginsEnabled'> | null | undefined
): boolean {
  return config == null || config.pluginsEnabled === true;
}
