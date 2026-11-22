import { getSyncConfig, isSyncConfigured } from './syncConfig';
import { initializeSharedLogin, requestSharedLogin } from './sharedLoginClient';

// Use the account profile when Web is connected. Unconfigured accounts keep the deployment's AI.

export const AI_SETTINGS_CHANGED = 'folia-ai-settings-changed';
export const AI_SETTINGS_SYNCED = 'folia-ai-settings-synced';

export const requestSyncedAi = async (operation: 'theme' | 'segment', body: string, signal?: AbortSignal) => {
    const config = getSyncConfig();
    if (!isSyncConfigured(config) || !config.deviceId || config.workerBaseUrl !== window.location.origin) return null;
    await initializeSharedLogin();
    const result = await requestSharedLogin('/ai/' + operation, 'POST', body, signal, undefined, config.deviceId);
    if (result.status === 404 || (result.status === 401 && result.body && typeof result.body === 'object'
        && 'error' in result.body && result.body.error === 'device_required')) return null;
    return result;
};
