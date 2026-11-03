import { apiClient } from './client';
import { getConfigValue, guardConfigConnection } from './configValue';
import { isRecord } from '@/utils/helpers';
import {
  isManagementOAuthProviderKey,
  normalizeManagementOAuthProviderKey,
} from '@/utils/providerKeys';
import type {
  PluginConfigField,
  PluginConfigObject,
  PluginDeleteResult,
  PluginListEntry,
  PluginListResponse,
  PluginMetadata,
  PluginMenu,
} from '@/types';

const asString = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return String(value);
};

const asBoolean = (value: unknown): boolean => value === true;

const normalizePluginOAuthProvider = (value: unknown): string | undefined => {
  const provider = normalizeManagementOAuthProviderKey(asString(value));
  return isManagementOAuthProviderKey(provider) ? provider : undefined;
};

const normalizeConfigField = (value: unknown): PluginConfigField | null => {
  if (!isRecord(value)) return null;
  const name = asString(value.name).trim();
  if (!name) return null;
  const enumValues = Array.isArray(value.enum_values)
    ? value.enum_values.map((item) => asString(item)).filter(Boolean)
    : [];
  return {
    name,
    type: asString(value.type).trim() || 'string',
    enumValues,
    description: asString(value.description).trim(),
  };
};

const normalizeConfigFields = (value: unknown): PluginConfigField[] =>
  Array.isArray(value)
    ? (value.map((item) => normalizeConfigField(item)).filter(Boolean) as PluginConfigField[])
    : [];

const normalizeMetadata = (value: unknown): PluginMetadata | null => {
  if (!isRecord(value)) return null;
  const name = asString(value.name).trim();
  const version = asString(value.version).trim();
  const author = asString(value.author).trim();
  const githubRepository = asString(value.github_repository).trim();
  const logo = asString(value.logo).trim();
  const configFields = normalizeConfigFields(value.config_fields);

  if (!name && !version && !author && !githubRepository && !logo && configFields.length === 0) {
    return null;
  }

  return {
    name,
    version,
    author,
    githubRepository,
    logo,
    configFields,
  };
};

const normalizeMenu = (value: unknown): PluginMenu | null => {
  if (!isRecord(value)) return null;
  const path = asString(value.path).trim();
  const menu = asString(value.menu).trim();
  if (!path && !menu) return null;
  return {
    path,
    menu,
    description: asString(value.description).trim(),
  };
};

const normalizeMenus = (value: unknown): PluginMenu[] =>
  Array.isArray(value)
    ? (value.map((item) => normalizeMenu(item)).filter(Boolean) as PluginMenu[])
    : [];

const normalizePluginEntry = (value: unknown): PluginListEntry | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;

  const metadata = normalizeMetadata(value.metadata);
  const configFields = normalizeConfigFields(value.config_fields);
  const supportsOAuth = asBoolean(value.supports_oauth);
  const oauthProvider = normalizePluginOAuthProvider(value.oauth_provider);
  const quotaProvider = asString(value.quota_provider).trim().toLowerCase();

  return {
    id,
    path: asString(value.path).trim(),
    configured: asBoolean(value.configured),
    registered: asBoolean(value.registered),
    enabled: value.enabled !== false,
    effectiveEnabled: asBoolean(value.effective_enabled),
    supportsOAuth,
    oauthProvider,
    supportsQuota: asBoolean(value.supports_quota),
    ...(quotaProvider ? { quotaProvider } : {}),
    logo: asString(value.logo || metadata?.logo).trim(),
    configFields: configFields.length > 0 ? configFields : (metadata?.configFields ?? []),
    menus: normalizeMenus(value.menus),
    metadata,
  };
};

const normalizePluginList = (value: unknown): PluginListResponse => {
  const source = isRecord(value) ? value : {};
  const plugins = Array.isArray(source.plugins)
    ? (source.plugins
        .map((item) => normalizePluginEntry(item))
        .filter(Boolean) as PluginListEntry[])
    : [];

  return {
    pluginsEnabled: asBoolean(source.plugins_enabled),
    pluginsDir: asString(source.plugins_dir).trim() || 'plugins',
    plugins,
  };
};

const normalizePluginConfig = (value: unknown): PluginConfigObject =>
  isRecord(value) ? { ...value } : {};

const normalizeDeleteResult = (value: unknown): PluginDeleteResult => {
  const source = isRecord(value) ? value : {};
  return {
    status: asString(source.status).trim(),
    id: asString(source.id).trim(),
    path: asString(source.path).trim(),
    fileDeleted: asBoolean(source.file_deleted),
    configuredRemoved: asBoolean(source.configured_removed),
    restartRequired: asBoolean(source.restart_required),
  };
};

export const pluginsApi = {
  async list(): Promise<PluginListResponse> {
    const data = await apiClient.get('/plugins');
    return normalizePluginList(data);
  },

  updateEnabled: (id: string, enabled: boolean) =>
    apiClient.put(`/config/plugins/configs/${encodeURIComponent(id)}/enabled`, enabled),

  async deletePlugin(id: string): Promise<PluginDeleteResult> {
    const data = await apiClient.delete(`/plugins/${encodeURIComponent(id)}`);
    return normalizeDeleteResult(data);
  },

  async getConfig(id: string): Promise<PluginConfigObject> {
    const data = await getConfigValue(`/config/plugins/configs/${encodeURIComponent(id)}`, {});
    return normalizePluginConfig(data);
  },

  async patchConfig(id: string, changes: PluginConfigObject) {
    // Form fields are complete values: clearing removes a field and editing an
    // object replaces that object. A v8 PATCH would instead retain nulls and
    // recursively merge objects, so merge touched fields into the latest object
    // and replace only this plugin instance (never the complete config tree).
    const assertConnection = guardConfigConnection();
    const next = { ...(await pluginsApi.getConfig(id)) };
    assertConnection();
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return apiClient.put(`/config/plugins/configs/${encodeURIComponent(id)}`, next);
  },
};

