import { getStoredString, removeStoredKey, setStoredString } from '../../stores/storagePrimitives';
import { ensureSyncConfigCurrent, getSyncConfig, isSyncConfigured, setSyncStatus, subscribeSyncConfig, syncAccountScope } from './syncConfig';
import { getRemoteState, testSyncConnection } from './syncClient';
import type { SyncProviderConfig } from './syncTypes';
import { applySyncedVisualSettings, buildSyncedSettingsRecord, getSyncedSettingsSignature, readSyncableSettingsState, watchSyncableSettings } from './settingsSnapshot';
import {
    fetchRemoteSyncState,
    fetchRemoteSettingsIfNewer,
    listAllRemoteThemeRecords,
    mergeLocalThemesIntoRecords,
    pushMissingLocalThemesToRemote,
    pushRemoteSettings,
    pushSyncLibraryBundleToRemote,
    saveSyncLibraryBundleToLocalCache,
} from './syncRepository';
import { parseSyncedSettingsRecord, parseSyncLibraryExportBundle } from './syncSchema';
import type { SyncedSettingsRecord, SyncLibraryExportBundle, SyncRemoteState } from './syncTypes';
import { SYNC_SCHEMA_VERSION } from './syncTypes';
import { AI_SETTINGS_CHANGED, AI_SETTINGS_SYNCED } from './syncedAi';

// src/services/sync/syncCoordinator.ts
// Coordinates automatic account sync and manual sync commands.

const LOCAL_SETTINGS_UPDATED_AT_KEY = 'folia_sync_local_settings_updated_at_v1';
const PENDING_SETTINGS_KEY = 'folia_sync_pending_settings_v1';
const SYNC_INTERVAL_MS = 5 * 60_000;
const SETTINGS_DEBOUNCE_MS = 1_500;
let applyingRemoteSettings = false;
let isSyncingInProgress = false;
let observedSettings: { scope: string; updatedAt: string | null } | null = null;

const isBrowser = () => typeof window !== 'undefined';

const getLocalSettingsUpdatedAt = (config: SyncProviderConfig) => {
    if (!isBrowser()) return null;
    const stored = getStoredString(LOCAL_SETTINGS_UPDATED_AT_KEY, '');
    if (!config.deviceId) return Number.isFinite(Date.parse(stored)) ? stored : null;
    const scope = syncAccountScope(config);
    if (!observedSettings || observedSettings.scope !== scope) {
        const prefix = scope + '\n';
        observedSettings = { scope, updatedAt: stored.startsWith(prefix) ? stored.slice(prefix.length) : null };
    }
    return observedSettings.updatedAt;
};

const setLocalSettingsUpdatedAt = (updatedAt: string, config = getSyncConfig()) => {
    if (!isBrowser()) return;
    const scope = syncAccountScope(config);
    const stamp = config.deviceId ? scope + '\n' + updatedAt : updatedAt;
    if (config.deviceId) observedSettings = { scope, updatedAt };
    setStoredString(LOCAL_SETTINGS_UPDATED_AT_KEY, stamp);
};

const settingsBelongToAnotherAccount = (config: SyncProviderConfig) => {
    if (!isBrowser()) return false;
    const stored = getStoredString(LOCAL_SETTINGS_UPDATED_AT_KEY, '');
    return stored.includes('\n') && !stored.startsWith(syncAccountScope(config) + '\n');
};

const getPendingSettings = (config: SyncProviderConfig): SyncedSettingsRecord | null => {
    const prefix = syncAccountScope(config) + '\n';
    const stored = getStoredString(PENDING_SETTINGS_KEY, '');
    if (!stored.startsWith(prefix)) return null;
    try {
        return parseSyncedSettingsRecord(JSON.parse(stored.slice(prefix.length)) as unknown);
    } catch {
        return null;
    }
};

const clearPendingSettings = (config: SyncProviderConfig, pending: SyncedSettingsRecord | null) => {
    if (pending && getPendingSettings(config)?.updatedAt === pending.updatedAt) removeStoredKey(PENDING_SETTINGS_KEY);
};

const pushCurrentSettings = async (config: SyncProviderConfig, automatic: boolean, pending: SyncedSettingsRecord | null) => {
    const record = automatic && pending ? pending
        : buildSyncedSettingsRecord(readSyncableSettingsState(), undefined, automatic);
    const pushed = await pushRemoteSettings(record, config);
    if (pushed) {
        ensureSyncConfigCurrent(config);
        // Another window can upload the pending record. Advance this window only if it has that data.
        if (!automatic || !pending || JSON.stringify(record.data) === getSyncedSettingsSignature(readSyncableSettingsState())) {
            setLocalSettingsUpdatedAt(record.updatedAt, config);
        }
        clearPendingSettings(config, pending);
    }
    return pushed;
};

export const initializeSyncCoordinator = () => {
    let timer: number | undefined;
    let fullSync = false;
    let signature = getSyncedSettingsSignature(readSyncableSettingsState());
    const schedule = (delay: number, themes: boolean) => {
        fullSync ||= themes;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            if (isSyncingInProgress) {
                schedule(SETTINGS_DEBOUNCE_MS, fullSync);
                return;
            }
            const config = getSyncConfig();
            const syncThemes = fullSync;
            fullSync = false;
            if (config.deviceId) {
                void syncNow({ syncThemes, applyRemoteSettings: true, automatic: true });
                const syncAi = window.electron?.syncAiProfile;
                if (syncAi && isSyncConfigured(config)) {
                    void syncAi(config.workerBaseUrl, config.deviceId).then(result => {
                        if (result.status === 'applied') window.dispatchEvent(new Event(AI_SETTINGS_SYNCED));
                        if (result.status === 'busy') schedule(SETTINGS_DEBOUNCE_MS, false);
                    }).catch((error: unknown) => console.warn('[sync] AI profile sync failed', error));
                }
            } else if (syncThemes) {
                void syncNow({ syncThemes: true });
            }
        }, delay);
    };
    const syncVisible = () => {
        if (document.visibilityState === 'visible') schedule(0, true);
    };
    const unsubscribeSettings = watchSyncableSettings(() => {
        const next = getSyncedSettingsSignature(readSyncableSettingsState());
        if (next === signature) return;
        signature = next;
        if (applyingRemoteSettings) return;
        const config = getSyncConfig();
        if (config.deviceId && isSyncConfigured(config) && !settingsBelongToAnotherAccount(config)) {
            const previousTime = Date.parse(getPendingSettings(config)?.updatedAt ?? '');
            const nextTime = Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0);
            const record = buildSyncedSettingsRecord(readSyncableSettingsState(), new Date(nextTime).toISOString(), true);
            setStoredString(PENDING_SETTINGS_KEY, syncAccountScope(config) + '\n' + JSON.stringify(record));
            schedule(SETTINGS_DEBOUNCE_MS, false);
        }
    });
    const unsubscribeConfig = subscribeSyncConfig(() => schedule(0, true));
    const interval = window.setInterval(syncVisible, SYNC_INTERVAL_MS);
    const receiveSettingsRevision = (event: StorageEvent) => {
        if (event.key === LOCAL_SETTINGS_UPDATED_AT_KEY && document.visibilityState === 'visible') schedule(0, false);
    };
    window.addEventListener('storage', receiveSettingsRevision);
    document.addEventListener('visibilitychange', syncVisible);
    const scheduleSettings = () => schedule(SETTINGS_DEBOUNCE_MS, false);
    window.addEventListener('online', syncVisible);
    window.addEventListener(AI_SETTINGS_CHANGED, scheduleSettings);
    schedule(0, true);

    return () => {
        window.clearTimeout(timer);
        window.clearInterval(interval);
        window.removeEventListener('storage', receiveSettingsRevision);
        document.removeEventListener('visibilitychange', syncVisible);
        window.removeEventListener('online', syncVisible);
        window.removeEventListener(AI_SETTINGS_CHANGED, scheduleSettings);
        unsubscribeConfig();
        unsubscribeSettings();
    };
};

export const testSyncProviderConnection = async (config: SyncProviderConfig) => {
    const response = await testSyncConnection(config);
    if (!response.ok) {
        return false;
    }

    return Boolean(await getRemoteState(config));
};

export const pullRemoteVisualSettings = async (remoteState?: SyncRemoteState | null, config = getSyncConfig()) => {
    if (!isSyncConfigured(config)) {
        return false;
    }

    const pending = getPendingSettings(config);
    const remoteSettings = await fetchRemoteSettingsIfNewer(pending?.updatedAt ?? getLocalSettingsUpdatedAt(config), remoteState, config);
    if (!remoteSettings) {
        return false;
    }

    ensureSyncConfigCurrent(config);
    if (getPendingSettings(config)?.updatedAt !== pending?.updatedAt) return false;
    applyingRemoteSettings = true;
    try {
        applySyncedVisualSettings(readSyncableSettingsState(), remoteSettings.data);
        setLocalSettingsUpdatedAt(remoteSettings.updatedAt, config);
        clearPendingSettings(config, pending);
        return true;
    } finally {
        applyingRemoteSettings = false;
    }
};

export type SyncNowResult = {
    uploadedThemeCount: number;
    downloadedThemeCount: number;
    checkedLocalThemeCount: number;
    diffBucketCount: number;
    skippedRemoteThemeScan: boolean;
    appliedRemoteSettings: boolean;
    pushedLocalSettings: boolean;
};

export const syncNow = async (options: { syncThemes?: boolean; applyRemoteSettings?: boolean; pushSettings?: boolean; automatic?: boolean } = {}): Promise<SyncNowResult | null> => {
    if (isSyncingInProgress) {
        return null;
    }

    const config = getSyncConfig();
    if (!isSyncConfigured(config)) {
        return null;
    }

    isSyncingInProgress = true;
    setSyncStatus({ state: 'syncing', lastError: null });
    try {
        const remoteState = await fetchRemoteSyncState(config);
        let themeSyncResult = {
            uploadedCount: 0,
            downloadedCount: 0,
            checkedLocalThemeCount: 0,
            diffBucketCount: 0,
            skippedRemoteThemeScan: true,
        };
        const pending = getPendingSettings(config);
        let appliedRemoteSettings = false;
        let pushedLocalSettings = false;
        if (options.applyRemoteSettings) {
            appliedRemoteSettings = await pullRemoteVisualSettings(remoteState, config);
        }
        const automaticPush = options.automatic && getPendingSettings(config)?.updatedAt === pending?.updatedAt
            && (pending || !remoteState?.settingsUpdatedAt && !getLocalSettingsUpdatedAt(config));
        const canPublishAppearance = options.pushSettings || (automaticPush && !settingsBelongToAnotherAccount(config));
        if (canPublishAppearance && !appliedRemoteSettings) {
            ensureSyncConfigCurrent(config);
            pushedLocalSettings = await pushCurrentSettings(config, options.automatic === true, pending);
        }
        if (options.syncThemes ?? true) {
            themeSyncResult = await pushMissingLocalThemesToRemote(remoteState, config);
        }
        setSyncStatus({ state: 'success', lastSyncAt: new Date().toISOString(), lastError: null });
        const summary = {
            uploadedThemeCount: themeSyncResult.uploadedCount,
            downloadedThemeCount: themeSyncResult.downloadedCount,
            checkedLocalThemeCount: themeSyncResult.checkedLocalThemeCount,
            diffBucketCount: themeSyncResult.diffBucketCount,
            skippedRemoteThemeScan: themeSyncResult.skippedRemoteThemeScan,
            appliedRemoteSettings,
            pushedLocalSettings,
        };
        console.info('[sync] Sync completed', summary);
        if (summary.downloadedThemeCount > 0 && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('folia-themes-synced'));
        }
        return summary;
    } catch (error) {
        console.error('[sync] Sync failed:', error);
        setSyncStatus({ state: 'error', lastError: error instanceof Error ? error.message : String(error) });
        return null;
    } finally {
        isSyncingInProgress = false;
    }
};

export const exportSyncLibraryBundle = async (): Promise<SyncLibraryExportBundle> => {
    setSyncStatus({ state: 'syncing', lastError: null });
    try {
        const config = getSyncConfig();
        const settings = settingsBelongToAnotherAccount(config)
            ? null
            : buildSyncedSettingsRecord(readSyncableSettingsState(), new Date().toISOString());
        const themes = await mergeLocalThemesIntoRecords(await listAllRemoteThemeRecords(), config);
        const bundle: SyncLibraryExportBundle = {
            kind: 'folia-sync-export',
            schemaVersion: SYNC_SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            settings,
            themes,
        };
        setSyncStatus({ state: 'success', lastSyncAt: bundle.exportedAt, lastError: null });
        console.info('[sync] Export completed', {
            themeCount: bundle.themes.length,
        });
        return bundle;
    } catch (error) {
        setSyncStatus({ state: 'error', lastError: error instanceof Error ? error.message : String(error) });
        throw error;
    }
};

export const isSyncLibraryExportBundle = (value: unknown): value is SyncLibraryExportBundle => (
    parseSyncLibraryExportBundle(value) !== null
);

export const importSyncLibraryBundle = async (
    bundle: unknown,
    options: { pushRemote?: boolean; config?: SyncProviderConfig } = {},
) => {
    const validatedBundle = parseSyncLibraryExportBundle(bundle);
    if (!validatedBundle) {
        throw new Error('Invalid Folia sync export');
    }

    const config = options.config ?? getSyncConfig();
    const pushRemote = (options.pushRemote ?? true) && isSyncConfigured(config);
    const pending = getPendingSettings(config);
    setSyncStatus({ state: 'syncing', lastError: null });
    try {
        if (pushRemote) {
            ensureSyncConfigCurrent(config);
            const remote = await fetchRemoteSyncState(config);
            if (!remote) throw new Error('Invalid sync state response');
            const timestamps = [remote.settingsUpdatedAt, remote.themesUpdatedAt, pending?.updatedAt];
            const nextTime = Math.max(Date.now(), ...timestamps.map(value => value ? Date.parse(value) + 1 : 0));
            const updatedAt = new Date(nextTime).toISOString();
            if (validatedBundle.settings) validatedBundle.settings.updatedAt = updatedAt;
            for (const theme of validatedBundle.themes) theme.updatedAt = updatedAt;
            await pushSyncLibraryBundleToRemote(validatedBundle, config);
            ensureSyncConfigCurrent(config);
        }
        await saveSyncLibraryBundleToLocalCache(validatedBundle, config.deviceId ? syncAccountScope(config) : undefined);
        if (pushRemote) ensureSyncConfigCurrent(config);
        if (validatedBundle.settings) {
            applyingRemoteSettings = true;
            try {
                applySyncedVisualSettings(readSyncableSettingsState(), validatedBundle.settings.data);
                setLocalSettingsUpdatedAt(validatedBundle.settings.updatedAt, config);
                clearPendingSettings(config, pending);
            } finally {
                applyingRemoteSettings = false;
            }
        }
        setSyncStatus({ state: 'success', lastSyncAt: new Date().toISOString(), lastError: null });
        console.info('[sync] Import completed', {
            pushedRemote: pushRemote,
            themeCount: validatedBundle.themes.length,
            appliedSettings: Boolean(validatedBundle.settings),
        });
        return true;
    } catch (error) {
        setSyncStatus({ state: 'error', lastError: error instanceof Error ? error.message : String(error) });
        throw error;
    }
};
