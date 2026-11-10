import type { Config } from '@/types';

/**
 * Log viewing reads local log files, so it is only offered when file logging is
 * enabled. A missing config means it is still loading; keep the page reachable
 * instead of hiding navigation on an unknown state.
 */
export function isLogsPageAvailable(
  config: Pick<Config, 'loggingToFile'> | null | undefined
): boolean {
  return config == null || config.loggingToFile === true;
}
