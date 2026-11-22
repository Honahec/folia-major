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
    providers?: readonly string[];
}

interface SharedLoginResponse {
    status: number;
    body: unknown;
    connectionId?: string | null;
}

let state: SharedLoginState = { available: false, device: null, origin: null };
let loading: Promise<void> | undefined;
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
    path: string, method = 'GET', body?: string, signal?: AbortSignal, connectionId?: string,
): Promise<SharedLoginResponse> => {
    const desktop = window.electron?.requestSharedLogin;
    const previous = state;
    signal?.throwIfAborted();
    const expectedDevice = path === '/device' && method === 'GET' ? undefined : previous.device?.id;
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
    if (previous === state && state.device && typeof response.body === 'object' && response.body !== null && 'error' in response.body
        && (response.body.error === 'device_required' || response.body.error === 'device_changed')) {
        loading = undefined;
        publish({ ...state, device: null, deviceLost: true });
    }
    return response;
};

export const initializeSharedLogin = (): Promise<void> => {
    loading ??= (async () => {
        const { electron, location } = window;
        const origin = electron ? await electron.getSharedLoginOrigin?.() ?? null : location.origin;
        if (electron && !origin) {
            publish({ ...state, available: Boolean(electron.enrollSharedLogin), device: null, origin: null });
            return;
        }
        const result = await requestSharedLogin('/device', 'GET', undefined, AbortSignal.timeout(5_000)).catch((error: unknown) => {
            if (electron && origin) publish({ ...state, origin, deviceLost: true });
            throw error;
        });
        publish({
            available: Boolean(electron?.enrollSharedLogin) || result.status === 200 || result.status === 401,
            device: deviceFrom(result.body),
            origin,
            providers: result.status === 200 ? providersFrom(result.body) : state.providers,
            deviceLost: result.status !== 200 && (state.deviceLost || Boolean(electron && origin)),
        });
    })().catch(() => {
        publish({ ...state, available: Boolean(window.electron?.enrollSharedLogin) });
        loading = undefined;
    });
    return loading;
};

export const enrollSharedLogin = async (origin: string, token: string, label: string): Promise<number> => {
    const desktop = window.electron?.enrollSharedLogin;
    const result = desktop ? await desktop(origin, token, label)
        : await requestSharedLogin('/enroll', 'POST', JSON.stringify({ token, label }));
    const device = deviceFrom(result.body);
    if (device) {
        publish({ available: true, device, origin: desktop ? new URL(origin).origin : window.location.origin });
        loading = undefined;
        await initializeSharedLogin();
    }
    return result.status;
};

export const listSharedLoginDevices = async (): Promise<SharedLoginDevice[]> => {
    const { body } = await requestSharedLogin('/devices');
    if (typeof body !== 'object' || body === null || !('devices' in body) || !Array.isArray(body.devices)) return [];
    return body.devices.map(deviceFrom).filter(device => device !== null);
};

export const revokeSharedLoginDevice = async (id: string): Promise<boolean> => {
    const previous = state;
    const current = previous.device?.id === id;
    const result = await requestSharedLogin(current ? '/device' : `/devices/${encodeURIComponent(id)}`, 'DELETE');
    if (result.status !== 200) return false;
    if (current && previous === state) publish({ ...state, device: null });
    return true;
};
