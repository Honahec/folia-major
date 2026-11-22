import { SYNC_PROVIDER, type SyncProviderConfig, type SyncRuntimeStatus } from './syncTypes';

// src/services/sync/syncConfig.ts
// Local persistence for user-owned sync server settings and runtime status.

const SYNC_CONFIG_STORAGE_KEY = 'folia_sync_config_v1';
const SYNC_STATUS_STORAGE_KEY = 'folia_sync_status_v1';
const SYNC_CONFIG_EVENT = 'folia-sync-config-changed';
const SYNC_STATUS_EVENT = 'folia-sync-status-changed';

const DEFAULT_CONFIG: SyncProviderConfig = {
    provider: SYNC_PROVIDER,
    enabled: false,
    workerBaseUrl: '',
    authToken: '',
};

const DEFAULT_STATUS: SyncRuntimeStatus = {
    state: 'idle',
    lastSyncAt: null,
    lastError: null,
};

const isBrowser = () => typeof window !== 'undefined';

const readJson = <T,>(key: string, fallback: T): T => {
    if (!isBrowser()) {
        return fallback;
    }

    const stored = window.localStorage.getItem(key);
    if (!stored) {
        return fallback;
    }

    try {
        return JSON.parse(stored) as T;
    } catch {
        return fallback;
    }
};

const emitEvent = (eventName: string) => {
    if (isBrowser()) {
        window.dispatchEvent(new Event(eventName));
    }
};

export const getSyncConfig = (): SyncProviderConfig => {
    const stored = readJson<Partial<SyncProviderConfig>>(SYNC_CONFIG_STORAGE_KEY, {});
    return {
        ...DEFAULT_CONFIG,
        ...stored,
        provider: SYNC_PROVIDER,
        workerBaseUrl: typeof stored.workerBaseUrl === 'string' ? stored.workerBaseUrl.trim() : '',
        authToken: typeof stored.authToken === 'string' ? stored.authToken.trim() : '',
        enabled: Boolean(stored.enabled),
        accountId: typeof stored.accountId === 'string' ? stored.accountId : undefined,
        deviceId: typeof stored.deviceId === 'string' ? stored.deviceId : undefined,
    };
};

export const saveSyncConfig = (config: SyncProviderConfig) => {
    if (!isBrowser()) {
        return;
    }

    window.localStorage.setItem(SYNC_CONFIG_STORAGE_KEY, JSON.stringify({
        provider: SYNC_PROVIDER,
        enabled: config.enabled,
        workerBaseUrl: config.workerBaseUrl.trim().replace(/\/+$/, ''),
        authToken: config.deviceId ? '' : config.authToken.trim(),
        deviceId: config.deviceId,
        accountId: config.accountId,
    }));
    emitEvent(SYNC_CONFIG_EVENT);
};

export const hasSyncConnection = (config: SyncProviderConfig) =>
    Boolean(config.workerBaseUrl && (config.authToken || config.deviceId));

export const isSyncConfigured = (config = getSyncConfig()) => (
    config.enabled && hasSyncConnection(config)
);

export const syncAccountScope = (config: SyncProviderConfig) =>
    `${config.workerBaseUrl}#${config.accountId ?? config.deviceId ?? ''}`;

export const ensureSyncConfigCurrent = (config: SyncProviderConfig) => {
    const current = getSyncConfig();
    if (!current.enabled || current.workerBaseUrl !== config.workerBaseUrl
        || current.deviceId !== config.deviceId || current.authToken !== config.authToken) {
        throw new Error('The sync connection changed');
    }
};

export const getSyncStatus = (): SyncRuntimeStatus => readJson(SYNC_STATUS_STORAGE_KEY, DEFAULT_STATUS);

export const setSyncStatus = (patch: Partial<SyncRuntimeStatus>) => {
    if (!isBrowser()) {
        return;
    }

    const next = {
        ...getSyncStatus(),
        ...patch,
    };
    window.localStorage.setItem(SYNC_STATUS_STORAGE_KEY, JSON.stringify(next));
    emitEvent(SYNC_STATUS_EVENT);
};

export const subscribeSyncConfig = (listener: () => void) => {
    if (!isBrowser()) {
        return () => undefined;
    }

    window.addEventListener(SYNC_CONFIG_EVENT, listener);
    const onStorage = (event: StorageEvent) => {
        if (event.key === SYNC_CONFIG_STORAGE_KEY) listener();
    };
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(SYNC_CONFIG_EVENT, listener);
        window.removeEventListener('storage', onStorage);
    };
};

export const subscribeSyncStatus = (listener: () => void) => {
    if (!isBrowser()) {
        return () => undefined;
    }

    window.addEventListener(SYNC_STATUS_EVENT, listener);
    return () => window.removeEventListener(SYNC_STATUS_EVENT, listener);
};
