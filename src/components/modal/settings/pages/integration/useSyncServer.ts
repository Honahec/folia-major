import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { createSyncLibraryZipBlob, readSyncLibraryZipFile } from '../../../../../services/sync/syncArchive';
import { getSyncConfig, getSyncStatus, hasSyncConnection, saveSyncConfig, setSyncStatus, subscribeSyncConfig, subscribeSyncStatus } from '../../../../../services/sync/syncConfig';
import { exportSyncLibraryBundle, importSyncLibraryBundle, isSyncLibraryExportBundle, syncNow, testSyncProviderConnection } from '../../../../../services/sync/syncCoordinator';
import { connectSyncConfig, SyncClientError } from '../../../../../services/sync/syncClient';
import { getSharedLoginState, initializeSharedLogin, watchSharedLoginState } from '../../../../../services/sync/sharedLoginClient';
import { omni } from '../../../../../services/onlineMusic/omni';
import { SYNC_PROVIDER, type SyncLibraryExportBundle, type SyncProviderConfig } from '../../../../../services/sync/syncTypes';
import { createSafeObjectUrl } from '../../../../../utils/blobGuards';
import { formatLocalDateTimeStamp } from '../../../../../utils/downloadFileName';

// src/components/modal/settings/pages/integration/useSyncServer.ts
// The sync server form of the 连接与集成 page. The switch, the address and the token are a draft
// until they are saved (the save button, a test that succeeds, or either sync). Besides the draft
// it holds what is running, the line that says how the last action went, and the actions: save,
// test, sync the AI themes, sync the visual settings, and write or read the sync library as a file.

type SyncAction = 'idle' | 'testing' | 'syncing' | 'syncingSettings' | 'exporting' | 'importing';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const useSyncServer = () => {
    const { t } = useTranslation();
    const shared = useSyncExternalStore(watchSharedLoginState, getSharedLoginState);
    const [saved, setSaved] = useState<SyncProviderConfig>(getSyncConfig);
    const [draft, setDraft] = useState<SyncProviderConfig>(getSyncConfig);
    const [status, setStatus] = useState(getSyncStatus);
    const [action, setAction] = useState<SyncAction>('idle');
    const [testResult, setTestResult] = useState<'idle' | 'success' | 'error'>('idle');
    const [summary, setSummary] = useState<string | null>(null);
    // A sync library read from a file, held until the person confirms that it replaces the local one.
    const [pendingImport, setPendingImport] = useState<{ bundle: SyncLibraryExportBundle; config: SyncProviderConfig } | null>(null);

    useEffect(() => {
        const unsubscribeConfig = subscribeSyncConfig(() => {
            const next = getSyncConfig();
            setSaved(next);
            setDraft(next);
            if (next.deviceId && getSharedLoginState().device?.id !== next.deviceId) void initializeSharedLogin(true);
        });
        const unsubscribeStatus = subscribeSyncStatus(() => setStatus(getSyncStatus()));
        return () => {
            unsubscribeConfig();
            unsubscribeStatus();
        };
    }, []);

    useEffect(() => { void initializeSharedLogin(); }, []);

    useEffect(() => {
        if (saved.workerBaseUrl || !shared.origin || action !== 'idle') return;
        if (shared.device) {
            saveSyncConfig({ ...getSyncConfig(), enabled: true, workerBaseUrl: shared.origin, deviceId: shared.device.id, accountId: shared.accountId });
        } else if (shared.available && !window.electron) {
            setDraft(previous => previous.workerBaseUrl ? previous : { ...previous, workerBaseUrl: shared.origin ?? '' });
        }
    }, [action, saved.workerBaseUrl, shared.origin, shared.device, shared.available, shared.accountId]);

    const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
    const connected = Boolean(draft.deviceId && shared.device?.id === draft.deviceId && shared.origin === draft.workerBaseUrl);
    const configured = hasSyncConnection({ ...draft, deviceId: connected ? draft.deviceId : undefined });
    const statusLabel = status.state === 'error'
        ? t('options.r2SyncStatusError')
        : status.lastSyncAt
            ? `${t('options.r2SyncLastSync')}: ${new Date(status.lastSyncAt).toLocaleString()}`
            : t('options.r2SyncStatusIdle');
    const statusTone: 'ok' | 'error' | undefined = testResult === 'success'
        ? 'ok'
        : testResult === 'error' || (!summary && status.state === 'error') ? 'error' : undefined;

    const update = (patch: Partial<SyncProviderConfig>) => {
        setDraft(previous => {
            const next = { ...previous, ...patch, provider: SYNC_PROVIDER };
            if (patch.workerBaseUrl === undefined || patch.workerBaseUrl === previous.workerBaseUrl) return next;
            if (shared.device && patch.workerBaseUrl.trim().replace(/\/+$/, '') === shared.origin) {
                return { ...next, authToken: '', deviceId: shared.device.id, accountId: shared.accountId };
            }
            return { ...next, deviceId: undefined, accountId: undefined };
        });
    };

    const save = async () => {
        setAction('testing');
        setTestResult('idle');
        setSummary(null);
        try {
            let next = draft;
            if (draft.enabled) {
                next = await connectSyncConfig(draft, t(window.electron ? 'options.syncDesktopDevice' : 'options.syncWebDevice'));
                if (next.deviceId) {
                    saveSyncConfig(next);
                    if (next.deviceId !== saved.deviceId) void omni.refreshSharedLoginAccounts();
                }
                if (!await testSyncProviderConnection(next)) {
                    setTestResult('error');
                    setSummary(t('ui.storage.syncTestFailed'));
                    return false;
                }
            }
            if (!next.deviceId || !next.enabled) saveSyncConfig(next);
            setTestResult('success');
            setSummary(t('ui.storage.syncTestSuccess'));
            return true;
        } catch (error) {
            setTestResult('error');
            const key = error instanceof SyncClientError && error.status === 401 ? 'options.syncInvalidToken' : 'ui.storage.syncTestFailed';
            setSummary(t(key));
            setSyncStatus({ state: 'error', lastError: t(key) });
            return false;
        } finally {
            setAction('idle');
        }
    };

    const test = async () => {
        if (dirty) {
            await save();
            return;
        }
        setAction('testing');
        setSummary(null);
        try {
            const passed = await testSyncProviderConnection(draft);
            setTestResult(passed ? 'success' : 'error');
            setSummary(t(passed ? 'ui.storage.syncTestSuccess' : 'ui.storage.syncTestFailed'));
        } catch {
            setTestResult('error');
            setSyncStatus({ state: 'error', lastError: t('ui.storage.syncTestFailed') });
        } finally {
            setAction('idle');
        }
    };

    const syncThemes = async () => {
        if (dirty && !await save()) return;
        setAction('syncing');
        setSummary(null);
        try {
            const result = await syncNow({ syncThemes: true, applyRemoteSettings: false, pushSettings: false });
            if (result) {
                setSummary(t('ui.storage.syncThemesComplete', {
                    uploaded: result.uploadedThemeCount,
                    downloaded: result.downloadedThemeCount,
                    local: result.checkedLocalThemeCount,
                    diff: result.diffBucketCount,
                }));
            }
        } finally {
            setAction('idle');
        }
    };

    const syncSettings = async () => {
        if (dirty && !await save()) return;
        setAction('syncingSettings');
        setSummary(null);
        try {
            const result = await syncNow({ syncThemes: false, applyRemoteSettings: true, pushSettings: true });
            if (result) {
                const parts: string[] = [];
                if (result.appliedRemoteSettings) parts.push(t('ui.storage.syncAppliedRemote'));
                if (result.pushedLocalSettings) parts.push(t('ui.storage.syncPushedLocal'));
                setSummary(parts.length > 0
                    ? t('ui.storage.syncSettingsComplete', { details: parts.join(', ') })
                    : t('ui.storage.syncSettingsNoChange'));
            }
        } finally {
            setAction('idle');
        }
    };

    /** Writes the sync library to a zip file and hands it to the browser as a download. */
    const exportLibrary = async () => {
        setAction('exporting');
        try {
            const url = createSafeObjectUrl(createSyncLibraryZipBlob(await exportSyncLibraryBundle()));
            if (!url) throw new TypeError('Sync export must produce a Blob');
            const link = document.createElement('a');
            link.href = url;
            link.download = `folia-sync-${formatLocalDateTimeStamp()}.zip`;
            link.click();
            URL.revokeObjectURL(url);
        } finally {
            setAction('idle');
        }
    };

    /** Reads a zip or JSON sync library and holds it for the confirmation; the import stays "running" until that is answered. */
    const readImportFile = async (file: File) => {
        const config = getSyncConfig();
        setAction('importing');
        try {
            const parsed = file.name.toLowerCase().endsWith('.zip')
                ? await readSyncLibraryZipFile(file)
                : JSON.parse(await file.text()) as unknown;
            if (!isSyncLibraryExportBundle(parsed)) {
                throw new Error('Invalid Folia sync export');
            }
            setPendingImport({ bundle: parsed, config });
        } catch (error) {
            setSyncStatus({ state: 'error', lastError: errorText(error) });
            setAction('idle');
        }
    };

    const cancelImport = () => {
        setPendingImport(null);
        setAction('idle');
    };

    /** Replaces the local sync library with the file that was read, and pushes it to the server when sync is on. */
    const confirmImport = async () => {
        const pending = pendingImport;
        setPendingImport(null);
        try {
            if (pending) await importSyncLibraryBundle(pending.bundle, { config: pending.config });
        } catch (error) {
            setSyncStatus({ state: 'error', lastError: errorText(error) });
        } finally {
            setAction('idle');
        }
    };

    return {
        draft,
        dirty,
        configured,
        connected,
        sharedDeviceId: shared.device?.id,
        action,
        statusText: summary || statusLabel,
        statusTone,
        hasPendingImport: pendingImport !== null,
        update,
        save,
        test,
        syncThemes,
        syncSettings,
        exportLibrary,
        readImportFile,
        cancelImport,
        confirmImport,
    };
};
