import { Navigate, useRoutes, type Location } from 'react-router-dom';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { ProvidersWorkbenchPage } from '@/features/providers/ProvidersWorkbenchPage';
import { AuthFilesPage } from '@/features/authFiles/AuthFilesPage';
import { AuthFilesOAuthExcludedEditPage } from '@/pages/AuthFilesOAuthExcludedEditPage';
import { AuthFilesOAuthModelAliasEditPage } from '@/pages/AuthFilesOAuthModelAliasEditPage';
import { OAuthPage } from '@/features/oauth/OAuthPage';
import { QuotaPage } from '@/features/quota/QuotaPage';
import { RoutingPage } from '@/features/routing/RoutingPage';
import { PluginResourcePage } from '@/features/plugins/PluginResourcePage';
import { PluginsPage } from '@/features/plugins/PluginsPage';
import { ConfigPage } from '@/features/config/ConfigPage';
import { LogsPage } from '@/features/logs/LogsPage';
import { isLogsPageAvailable } from '@/features/logs/model/logAvailability';
import { isPluginsPageAvailable } from '@/features/plugins/pluginAvailability';
import { SystemPage } from '@/pages/SystemPage';
import { useAuthStore, useConfigStore } from '@/stores';

const createMainRoutes = (logsAvailable: boolean, pluginsAvailable: boolean) => [
  { path: '/', element: <DashboardPage /> },
  { path: '/dashboard', element: <DashboardPage /> },
  { path: '/settings', element: <Navigate to="/config" replace /> },
  { path: '/api-keys', element: <Navigate to="/config" replace /> },
  { path: '/quick-start', element: <Navigate to="/" replace /> },
  { path: '/quick-start/*', element: <Navigate to="/" replace /> },
  { path: '/ai-providers', element: <ProvidersWorkbenchPage /> },
  { path: '/ai-providers/*', element: <Navigate to="/ai-providers" replace /> },
  { path: '/auth-files', element: <AuthFilesPage /> },
  { path: '/auth-files/oauth-excluded', element: <AuthFilesOAuthExcludedEditPage /> },
  { path: '/auth-files/oauth-model-alias', element: <AuthFilesOAuthModelAliasEditPage /> },
  { path: '/oauth', element: <OAuthPage /> },
  { path: '/routing', element: <RoutingPage /> },
  { path: '/quota', element: <QuotaPage /> },
  ...(pluginsAvailable
    ? [{ path: '/plugin-pages/:pluginId/:menuIndex', element: <PluginResourcePage /> }]
    : [{ path: '/plugin-pages/*', element: <Navigate to="/" replace /> }]),
  { path: '/plugins', element: pluginsAvailable ? <PluginsPage /> : <Navigate to="/" replace /> },
  {
    path: '/plugins/*',
    element: pluginsAvailable ? (
      <Navigate to="/plugins" replace />
    ) : (
      <Navigate to="/" replace />
    ),
  },
  { path: '/config', element: <ConfigPage /> },
  { path: '/logs', element: logsAvailable ? <LogsPage /> : <Navigate to="/" replace /> },
  { path: '/system', element: <SystemPage /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

export function MainRoutes({ location }: { location?: Location }) {
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  const logsAvailable = useConfigStore((state) => isLogsPageAvailable(state.config));
  const pluginsEnabled = useConfigStore((state) => isPluginsPageAvailable(state.config));
  const pluginsAvailable = supportsPlugin && pluginsEnabled;
  return useRoutes(createMainRoutes(logsAvailable, pluginsAvailable), location);
}
