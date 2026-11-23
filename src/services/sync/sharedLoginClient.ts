import { getSyncConfig, saveSyncConfig, setSyncStatus } from './syncConfig';

// Connect this device to a shared login server without retaining the enrollment token.

export interface SharedLoginDevice {
    id: string;
    label: string;
}

export interface SharedLoginState {
    available: boolean;
    device: SharedLoginDevice | null;
    origin: string | null;
    deviceLost?: boolean;
    discoveryUnavailable?: boolean;
    providers?: readonly string[];
    accountId?: string;
}

interface SharedLoginResponse {
    status: number;
    body: unknown;
    connectionId?: string | null;
}

let state: SharedLoginState = { available: false, device: null, origin: null };
let loading: Promise<void> | undefined;
let discoveryGeneration = 0;
const listeners = new Set<() => void>();

const publish = (next: SharedLoginState) => {
    state = next;
    listeners.forEach(listener => listener());
};

const deviceFrom = (body: unknown): SharedLoginDevice | null => {
    if (typeof body !== 'object' || body === null || !('id' in body) || !('label' in body)
        || typeof body.id !== 'string' || typeof body.label !== 'string') return null;
    return { id: body.id, label: body.label };
};

const providersFrom = (body: unknown): readonly string[] => (
    typeof body === 'object' && body !== null && 'providers' in body && Array.isArray(body.providers)
        ? body.providers.filter((item): item is string => typeof item === 'string') : []
);

export const getSharedLoginState = () => state;
export const watchSharedLoginState = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export const requestSharedLogin = async (
    path: string, method = 'GET', body?: string, signal?: AbortSignal, connectionId?: string, deviceId?: string,
): Promise<SharedLoginResponse> => {
    const desktop = window.electron?.requestSharedLogin;
    const previous = state;
    signal?.throwIfAborted();
    const expectedDevice = path === '/device' && method === 'GET' ? undefined : deviceId ?? previous.device?.id;
    const headers = new Headers();
    if (body) headers.set('Content-Type', 'application/json');
    if (connectionId) headers.set('X-Folia-Connection', connectionId);
    if (expectedDevice) headers.set('X-Folia-Device', expectedDevice);
    const response = desktop ? await desktop(path, method, body, expectedDevice, connectionId) : await fetch(`/api/shared-login${path}`, {
        method,
        body,
        signal,
        credentials: 'same-origin',
        redirect: 'error',
        headers,
    }).then(async result => ({ status: result.status, body: await result.json().catch(() => null) as unknown, connectionId: result.headers.get('X-Folia-Connection') }));
    signal?.throwIfAborted();
    if (expectedDevice && previous === state && state.device?.id === expectedDevice
        && typeof response.body === 'object' && response.body !== null && 'error' in response.body
        && (response.body.error === 'device_required' || response.body.error === 'device_changed')) {
        discoveryGeneration++;
        loading = undefined;
        publish({ ...state, device: null, deviceLost: true, discoveryUnavailable: false });
    }
    return response;
};

export const initializeSharedLogin = (refresh = false): Promise<void> => {
    if (refresh) loading = undefined;
    if (loading) return loading;
    const generation = ++discoveryGeneration;
    loading = (async () => {
        const { electron, location } = window;
        const origin = electron ? await electron.getSharedLoginOrigin?.().catch(() => null) ?? null : location.origin;
        if (generation !== discoveryGeneration) return loading;
        const config = getSyncConfig();
        if (electron && !origin && !state.deviceLost) {
            if (config.deviceId || state.device) {
                publish({ ...state, device: null, origin: state.origin ?? config.workerBaseUrl, discoveryUnavailable: true });
                throw new Error('The desktop shared login session is unavailable');
            }
            publish({ available: Boolean(electron.enrollSharedLogin), device: null, origin: null });
            return;
        }
        const previous = state;
        const enrolled = electron ? Boolean(origin) : Boolean(config.deviceId);
        const unavailable = () => {
            if (generation === discoveryGeneration && (enrolled || previous.device)) {
                publish({ ...state, origin, discoveryUnavailable: true });
            }
        };
        const result = await requestSharedLogin('/device', 'GET', undefined, AbortSignal.timeout(5_000)).catch((error: unknown) => {
            unavailable();
            throw error;
        });
        if (generation !== discoveryGeneration) return loading;
        const device = result.status === 200 ? deviceFrom(result.body) : null;
        const rejected = result.status === 401 && (result.body as { error?: unknown } | null)?.error === 'device_required';
        if (!device && !rejected) {
            if (!enrolled && !previous.device && !previous.deviceLost) return;
            unavailable();
            throw new Error('Shared login discovery is unavailable');
        }
        publish({
            available: true,
            device,
            origin,
            accountId: result.status === 200 && typeof result.body === 'object' && result.body !== null
                && 'accountId' in result.body && typeof result.body.accountId === 'string' ? result.body.accountId : undefined,
            providers: result.status === 200 ? providersFrom(result.body) : state.providers,
            deviceLost: rejected && (Boolean(previous.deviceLost || previous.device) || enrolled),
        });
    })().catch(() => {
        if (generation !== discoveryGeneration) return loading;
        publish({ ...state, available: Boolean(window.electron?.enrollSharedLogin) });
        loading = undefined;
    });
    return loading;
};

export const enrollSharedLogin = async (origin: string, token: string, label: string) => {
    const desktop = window.electron?.enrollSharedLogin;
    const expectedOrigin = desktop ? new URL(origin).origin : window.location.origin;
    const result = desktop ? await desktop(origin, token, label)
        : await requestSharedLogin('/enroll', 'POST', JSON.stringify({ token, label }));
    const device = deviceFrom(result.body);
    if (result.status !== 201 || !device) return { status: result.status, connection: null };

    publish({ available: true, device, origin: expectedOrigin });
    await initializeSharedLogin(true);
    const connection = getSharedLoginState();
    if (connection.device?.id !== device.id || connection.origin !== expectedOrigin) {
        return { status: 409, connection: null };
    }
    return { status: 201, connection: { device, accountId: connection.accountId } };
};

export const listSharedLoginDevices = async (): Promise<SharedLoginDevice[]> => {
    const { body } = await requestSharedLogin('/devices');
    if (typeof body !== 'object' || body === null || !('devices' in body) || !Array.isArray(body.devices)) return [];
    return body.devices.map(deviceFrom).filter(device => device !== null);
};

export const renameSharedLoginDevice = async (id: string, label: string): Promise<boolean> => {
    const previous = state;
    if (previous.device?.id !== id) return false;
    const result = await requestSharedLogin('/device', 'POST', JSON.stringify({ label }));
    const device = deviceFrom(result.body);
    if (result.status !== 200 || device?.id !== id || state.device?.id !== id || state.origin !== previous.origin) {
        return false;
    }
    publish({ ...state, device });
    return true;
};

export const revokeSharedLoginDevice = async (id: string): Promise<boolean> => {
    const previous = state;
    const current = previous.device?.id === id;
    const result = await requestSharedLogin(current ? '/device' : `/devices/${encodeURIComponent(id)}`, 'DELETE');
    if (result.status !== 200) return false;
    if (current && state.origin === previous.origin && (!state.device || state.device.id === id)) {
        discoveryGeneration++;
        loading = undefined;
        publish({ available: state.available, device: null, origin: state.origin, providers: state.providers });
    }
    const config = getSyncConfig();
    if (current && config.deviceId === id && config.workerBaseUrl === previous.origin) {
        saveSyncConfig({ ...config, enabled: false, authToken: '', deviceId: undefined, accountId: undefined });
        setSyncStatus({ state: 'idle', lastSyncAt: null, lastError: null });
    }
    return true;
};
