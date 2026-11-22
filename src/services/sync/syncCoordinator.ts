import { getStoredString, setStoredString } from '../../stores/storagePrimitives';
import { ensureSyncConfigCurrent, getSyncConfig, isSyncConfigured, setSyncStatus, syncAccountScope } from './syncConfig';
import { getRemoteState, testSyncConnection } from './syncClient';
import type { SyncProviderConfig } from './syncTypes';
import { applySyncedVisualSettings, buildSyncedSettingsRecord, readSyncableSettingsState } from './settingsSnapshot';
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
import { parseSyncLibraryExportBundle } from './syncSchema';
import type { SyncLibraryExportBundle, SyncRemoteState } from './syncTypes';
import { SYNC_SCHEMA_VERSION } from './syncTypes';

// src/services/sync/syncCoordinator.ts
// Coordinates startup theme sync and user-triggered manual sync commands.

const LOCAL_SETTINGS_UPDATED_AT_KEY = 'folia_sync_local_settings_updated_at_v1';
let applyingRemoteSettings = false;
let isSyncingInProgress = false;

const isBrowser = () => typeof window !== 'undefined';

const getLocalSettingsUpdatedAt = (config: SyncProviderConfig) => {
    if (!isBrowser()) return null;
    const stored = getStoredString(LOCAL_SETTINGS_UPDATED_AT_KEY, '');
    if (!stored) return null;
    if (!config.deviceId) return Number.isFinite(Date.parse(stored)) ? stored : null;
    const prefix = syncAccountScope(config) + '\n';
    return stored.startsWith(prefix) ? stored.slice(prefix.length) : null;
};

const setLocalSettingsUpdatedAt = (updatedAt: string, config = getSyncConfig()) => {
    if (!isBrowser()) return;
    const stamp = config.deviceId ? syncAccountScope(config) + '\n' + updatedAt : updatedAt;
    setStoredString(LOCAL_SETTINGS_UPDATED_AT_KEY, stamp);
};

const settingsBelongToAnotherAccount = (config: SyncProviderConfig) => {
    if (!isBrowser()) return false;
    const stored = getStoredString(LOCAL_SETTINGS_UPDATED_AT_KEY, '');
    return stored.includes('\n') && !stored.startsWith(syncAccountScope(config) + '\n');
};

const pushCurrentSettings = async (config = getSyncConfig()) => {
    if (!isSyncConfigured(config)) {
        return false;
    }

    const updatedAt = new Date().toISOString();
    const record = buildSyncedSettingsRecord(readSyncableSettingsState(), updatedAt);
    const pushed = await pushRemoteSettings(record, config);
    if (pushed) setLocalSettingsUpdatedAt(updatedAt, config);
    return pushed;
};

export const initializeSyncCoordinator = () => {
    void syncNow({ syncThemes: true, applyRemoteSettings: false, pushSettings: false });

    return () => {};
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

    const remoteSettings = await fetchRemoteSettingsIfNewer(getLocalSettingsUpdatedAt(config), remoteState, config);
    if (!remoteSettings) {
        return false;
    }

    ensureSyncConfigCurrent(config);
    applyingRemoteSettings = true;
    try {
        applySyncedVisualSettings(readSyncableSettingsState(), remoteSettings.data);
        setLocalSettingsUpdatedAt(remoteSettings.updatedAt, config);
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

export const syncNow = async (options: { syncThemes?: boolean; applyRemoteSettings?: boolean; pushSettings?: boolean } = {}): Promise<SyncNowResult | null> => {
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
        if (options.syncThemes ?? true) {
            themeSyncResult = await pushMissingLocalThemesToRemote(remoteState, config);
        }
        
        let appliedRemoteSettings = false;
        let pushedLocalSettings = false;
        if (options.applyRemoteSettings) {
            appliedRemoteSettings = await pullRemoteVisualSettings(remoteState, config);
        }
        if (options.pushSettings && !appliedRemoteSettings && !settingsBelongToAnotherAccount(config)) {
            ensureSyncConfigCurrent(config);
            pushedLocalSettings = await pushCurrentSettings(config);
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
    setSyncStatus({ state: 'syncing', lastError: null });
    try {
        if (pushRemote) ensureSyncConfigCurrent(config);
        await saveSyncLibraryBundleToLocalCache(validatedBundle);
        if (pushRemote) ensureSyncConfigCurrent(config);
        if (validatedBundle.settings) {
            applyingRemoteSettings = true;
            try {
                applySyncedVisualSettings(readSyncableSettingsState(), validatedBundle.settings.data);
                setLocalSettingsUpdatedAt(validatedBundle.settings.updatedAt);
            } finally {
                applyingRemoteSettings = false;
            }
        }
        if (pushRemote) {
            await pushSyncLibraryBundleToRemote(validatedBundle, config);
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
