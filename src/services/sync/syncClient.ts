import { enrollSharedLogin, getSharedLoginState, initializeSharedLogin, requestSharedLogin } from './sharedLoginClient';
import type {
    SyncProviderConfig,
    SyncRemoteState,
    SyncThemeManifest,
    SyncedSettingsRecord,
    SyncedThemeRecord,
    WorkerHealthResponse,
} from './syncTypes';
import {
    parseSyncRemoteState,
    parseSyncThemeManifest,
    parseSyncedSettingsRecord,
    parseSyncedThemeRecords,
} from './syncSchema';

// src/services/sync/syncClient.ts
// HTTP adapter for Folia's user-hosted sync API.

export class SyncClientError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'SyncClientError';
        this.status = status;
    }
}

export type ThemeListPage = {
    themes: SyncedThemeRecord[];
    cursor: string | null;
};

const buildUrl = (config: SyncProviderConfig, path: string) => (
    `${config.workerBaseUrl.replace(/\/+$/, '')}${path}`
);

const requestJson = async <T,>(
    config: SyncProviderConfig,
    path: string,
    init: RequestInit = {},
): Promise<T> => {
    if (config.deviceId) {
        await initializeSharedLogin();
        const matches = () => getSharedLoginState().device?.id === config.deviceId && getSharedLoginState().origin === config.workerBaseUrl;
        if (!matches()) await initializeSharedLogin(true);
        if (!matches()) {
            throw new SyncClientError('Reconnect this device to the sync server', 401);
        }
        const result = await requestSharedLogin(`/sync${path}`, init.method, typeof init.body === 'string' ? init.body : undefined);
        if (getSharedLoginState().device?.id !== config.deviceId) {
            throw new SyncClientError('The sync device changed', 409);
        }
        if (result.status < 200 || result.status >= 300) throw new SyncClientError(`Sync request failed: ${result.status}`, result.status);
        return result.body as T;
    }
    const response = await fetch(buildUrl(config, path), {
        ...init,
        headers: {
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            Authorization: `Bearer ${config.authToken}`,
            ...init.headers,
        },
    });

    if (!response.ok) {
        throw new SyncClientError(`Sync request failed: ${response.status}`, response.status);
    }

    if (response.status === 204) {
        return null as T;
    }

    return await response.json() as T;
};

export const connectSyncConfig = async (config: SyncProviderConfig, deviceLabel: string): Promise<SyncProviderConfig> => {
    const workerBaseUrl = config.workerBaseUrl.trim().replace(/\/+$/, '');
    const authToken = config.authToken.trim();
    const url = new URL(workerBaseUrl);
    const next = { ...config, workerBaseUrl, authToken };
    if (!authToken && config.deviceId) return next;
    if (url.origin === workerBaseUrl) {
        const health = await fetch(`${url.origin}/api/sync/health`, {
            credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5_000),
        }).then(async response => {
            const body = await response.json().catch(() => null) as WorkerHealthResponse | null;
            return body?.backend === 'folia-worker-sync' ? body : null;
        }).catch(() => null);
        if (health) {
            if (!health.ok) throw new SyncClientError('The sync database is unavailable', 503);
            if (!window.electron?.enrollSharedLogin && window.location.origin !== url.origin) {
                throw new SyncClientError('Open the sync server address in this browser to connect', 400);
            }
            const { status, connection } = await enrollSharedLogin(url.origin, authToken, deviceLabel);
            if (!connection) throw new SyncClientError(`Sync enrollment failed: ${status}`, status);
            const { device, accountId } = connection;
            return { ...next, authToken: '', deviceId: device.id, accountId };
        }
    }
    return { ...next, deviceId: undefined, accountId: undefined };
};

export const testSyncConnection = async (config: SyncProviderConfig) => (
    await requestJson<WorkerHealthResponse>(config, '/health')
);

export const getRemoteState = async (config: SyncProviderConfig): Promise<SyncRemoteState | null> => (
    parseSyncRemoteState(await requestJson(config, '/state'))
);

export const getRemoteThemeManifest = async (config: SyncProviderConfig): Promise<SyncThemeManifest | null> => (
    parseSyncThemeManifest(await requestJson(config, '/themes/manifest'))
);

export const getRemoteSettings = async (config: SyncProviderConfig): Promise<SyncedSettingsRecord | null> => (
    parseSyncedSettingsRecord(await requestJson(config, '/settings'))
);

export const putRemoteSettings = async (config: SyncProviderConfig, record: SyncedSettingsRecord) => {
    await requestJson(config, '/settings', {
        method: 'PUT',
        body: JSON.stringify(record),
    });
};

export const getRemoteThemes = async (
    config: SyncProviderConfig,
    fingerprints: string[],
): Promise<SyncedThemeRecord[]> => {
    const uniqueFingerprints = Array.from(new Set(fingerprints.filter(Boolean)));
    if (uniqueFingerprints.length === 0) {
        return [];
    }

    const response = await requestJson<{ themes?: unknown[] }>(config, '/themes/get', {
        method: 'POST',
        body: JSON.stringify({ fingerprints: uniqueFingerprints }),
    });

    return parseSyncedThemeRecords(response.themes ?? []);
};

export const putRemoteThemes = async (
    config: SyncProviderConfig,
    themes: SyncedThemeRecord[],
) => {
    if (themes.length === 0) {
        return;
    }

    await requestJson(config, '/themes/put', {
        method: 'POST',
        body: JSON.stringify({ themes }),
    });
};

export const getRemoteThemesByBuckets = async (
    config: SyncProviderConfig,
    bucketIds: number[],
): Promise<SyncedThemeRecord[]> => {
    const ids = Array.from(new Set(bucketIds.filter(Number.isInteger)));
    if (ids.length === 0) {
        return [];
    }

    const response = await requestJson<{ themes?: unknown[] }>(config, '/themes/bucket', {
        method: 'POST',
        body: JSON.stringify({ bucketIds: ids }),
    });

    return parseSyncedThemeRecords(response.themes ?? []);
};

export const listRemoteThemes = async (
    config: SyncProviderConfig,
    options: { cursor?: string | null; limit?: number } = {},
): Promise<ThemeListPage> => {
    const response = await requestJson<{ themes?: unknown[]; cursor?: unknown }>(config, '/themes/list', {
        method: 'POST',
        body: JSON.stringify({
            cursor: options.cursor ?? null,
            limit: options.limit ?? 500,
        }),
    });

    return {
        themes: parseSyncedThemeRecords(response.themes ?? []),
        cursor: typeof response.cursor === 'string' && response.cursor ? response.cursor : null,
    };
};
