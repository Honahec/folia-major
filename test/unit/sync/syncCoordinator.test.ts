import { afterEach, expect, it, vi } from 'vitest';
import { initializeSyncCoordinator } from '../../../src/services/sync/syncCoordinator';
import { fetchRemoteSettingsIfNewer, pushRemoteSettings } from '../../../src/services/sync/syncRepository';
import type { SyncedVisualSettings } from '../../../src/services/sync/syncTypes';

// Debounced account uploads retain the edited snapshot even if another tab runs the sync.

const settings = vi.hoisted(() => ({
    data: {} as SyncedVisualSettings,
    listener: undefined as (() => void) | undefined,
}));
vi.mock('../../../src/services/sync/settingsSnapshot', () => ({
    readSyncableSettingsState: () => settings.data,
    getSyncedSettingsSignature: JSON.stringify,
    buildSyncedSettingsRecord: (data: SyncedVisualSettings, updatedAt = new Date().toISOString()) => ({
        data, updatedAt, schemaVersion: 1,
    }),
    watchSyncableSettings: (listener: () => void) => {
        settings.listener = listener;
        return () => { settings.listener = undefined; };
    },
}));
vi.mock('../../../src/services/sync/syncRepository', () => ({
    fetchRemoteSyncState: vi.fn().mockResolvedValue({ settingsUpdatedAt: '2024-01-01T00:00:00.000Z' }),
    fetchRemoteSettingsIfNewer: vi.fn().mockResolvedValue(null),
    pushRemoteSettings: vi.fn().mockResolvedValue(true),
    pushMissingLocalThemesToRemote: vi.fn().mockResolvedValue({
        uploadedCount: 0, downloadedCount: 0, checkedLocalThemeCount: 0, diffBucketCount: 0, skippedRemoteThemeScan: true,
    }),
}));

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

it('pulls on startup and uploads the saved appearance edit once after the debounce', async () => {
    vi.useFakeTimers();
    const browser = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval });
    const local = new Map<string, string>([['folia_sync_config_v1', JSON.stringify({
        enabled: true, workerBaseUrl: 'https://folia.example', accountId: 'alice', deviceId: 'device',
    })]]);
    const localStorage = {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => local.set(key, value),
        removeItem: (key: string) => local.delete(key),
    };
    vi.stubGlobal('window', Object.assign(browser, { localStorage }));
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    settings.data = { backgroundOpacity: 0.1 };
    const dispose = initializeSyncCoordinator();
    try {
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchRemoteSettingsIfNewer).toHaveBeenCalledTimes(1);
        expect(pushRemoteSettings).not.toHaveBeenCalled();
        settings.data = { backgroundOpacity: 0.7 };
        settings.listener?.();
        settings.data = { backgroundOpacity: 0.1 };
        await vi.advanceTimersByTimeAsync(1499);
        expect(pushRemoteSettings).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(pushRemoteSettings).toHaveBeenCalledTimes(1);
        expect(pushRemoteSettings).toHaveBeenCalledWith(expect.objectContaining({ data: { backgroundOpacity: 0.7 } }), expect.anything());
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(fetchRemoteSettingsIfNewer).toHaveBeenCalledTimes(3);
        expect(pushRemoteSettings).toHaveBeenCalledTimes(1);
    } finally {
        dispose();
    }
});
