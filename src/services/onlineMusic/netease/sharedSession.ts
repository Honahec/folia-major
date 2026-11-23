import { getSharedLoginState, requestSharedLogin, type SharedLoginDevice } from '../../sync/sharedLoginClient';
import { useOnlineProviderAccountStore } from '../../../stores/useOnlineProviderAccountStore';
import { OnlineProviderError } from '../../../types/onlineMusic';
import { withOnlineRequestLimit } from '../failure/onlineRequestLimit';

// Keep a connection identifier with the account shown in Folia. The credential stays in the Worker.

let observed: { deviceId: string; connectionId: string; accountId: string } | null = null;
let statusSequence = 0;
let statusRequest: { device: SharedLoginDevice; sequence: number; pending: Promise<Response> } | null = null;
let connectionCheck: { deviceId: string; at: number } | null = null;

const displayedAccountId = (): string | undefined => {
    const { accounts } = useOnlineProviderAccountStore.getState();
    const knownAccounts: Partial<typeof accounts> = accounts;
    const shown = knownAccounts.netease?.user;
    return shown ? String(shown.id) : undefined;
};

export const hasSharedNeteaseConnectionChanged = async (): Promise<boolean> => {
    const device = getSharedLoginState().device;
    if (!device || !usesSharedNeteaseSession()) return false;
    const at = Date.now();
    if (connectionCheck?.deviceId === device.id && at - connectionCheck.at < 5_000) return false;
    connectionCheck = { deviceId: device.id, at };
    const sequence = statusSequence;
    const result = await requestSharedLogin('/netease/connection', 'GET', undefined, AbortSignal.timeout(5_000));
    if (result.status !== 200 || getSharedLoginState().device !== device || sequence !== statusSequence) return false;
    const value = result.body as { connectionId?: string | null } | null;
    const seen = observed?.deviceId === device.id ? observed : null;
    if (value?.connectionId === undefined) return false;
    return value.connectionId !== (seen?.connectionId ?? null) || seen?.accountId !== displayedAccountId();
};
const writes = new Set([
    '/like', '/playlist/tracks', '/playlist/subscribe', '/album/sub', '/scrobble/v1',
    '/recommend/songs/dislike', '/recommend/category/set', '/fm_trash',
    '/playlist/create', '/playlist/name/update', '/playlist/desc/update', '/playlist/tags/update',
    '/artist/sub', '/follow', '/scrobble', '/daily_signin',
]);

export const usesSharedNeteaseSession = (): boolean => {
    const state = getSharedLoginState();
    return Boolean((state.device || state.deviceLost || state.discoveryUnavailable) && (state.providers?.includes('netease') ?? true));
};

export const hasSharedNeteaseAccount = (): boolean =>
    Boolean(observed && observed.deviceId === getSharedLoginState().device?.id);

const accountIdFrom = (body: unknown): string | null => {
    const reply = body as { data?: { profile?: { userId?: string | number; id?: string | number } } } | null;
    const id = reply?.data?.profile?.userId ?? reply?.data?.profile?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
};

const sendSharedNetease = async (endpoint: string, signal?: AbortSignal): Promise<Response> => {
    const { device, discoveryUnavailable } = getSharedLoginState();
    if (!device) {
        if (discoveryUnavailable) {
            throw new OnlineProviderError('network', 'Shared login discovery is unavailable', 'netease');
        }
        throw new OnlineProviderError('auth-required', 'Reconnect this device to use the shared sign-in', 'netease');
    }

    const route = endpoint.split('?')[0];
    const status = route === '/login/status';
    const sequence = statusSequence;
    const probe = status || route === '/user/account' || route.startsWith('/login/qr/');
    const connection = observed?.deviceId === device.id ? observed : null;
    const shown = displayedAccountId();
    if (!probe && connection && shown && shown !== connection.accountId) {
        throw new OnlineProviderError('unavailable', 'NetEase is switching to a different shared account', 'netease');
    }
    if (route === '/logout' && !connection) {
        throw new OnlineProviderError('auth-required', 'Read the shared account before unlinking it', 'netease');
    }
    const path = route === '/logout' ? '/netease/connection' : `/netease${endpoint}`;
    const method = route === '/logout' ? 'DELETE' : writes.has(route) ? 'POST' : 'GET';
    const result = await requestSharedLogin(path, method, undefined, signal, connection?.connectionId);
    const latest = getSharedLoginState();
    if (device !== latest.device) {
        throw new OnlineProviderError(latest.deviceLost ? 'auth-required' : 'unavailable', 'Shared login device changed', 'netease');
    }
    const reply = result.body as { error?: string; code?: number; data?: { code?: number; profile?: unknown } } | null;
    if (result.status === 409 && reply?.error === 'connection_changed') {
        throw new OnlineProviderError('unavailable', 'The shared NetEase account changed. Refresh the account and try again.', 'netease');
    }
    if (result.status === 404 && reply?.error === 'not_found') {
        throw new OnlineProviderError('unsupported', 'This route is not available through shared NetEase login', 'netease');
    }
    if (route === '/login/qr/check' && reply?.code === 803) {
        statusSequence += 1;
        observed = null;
    }
    if (status && sequence !== statusSequence) {
        throw new OnlineProviderError('unavailable', 'A newer NetEase account check replaced this request', 'netease');
    }
    if (status) {
        const code = Number(reply?.code ?? reply?.data?.code);
        const accountId = accountIdFrom(result.body);
        const signedOut = result.status < 500 && [301, 401, 403].includes(code);
        if (signedOut || (result.status === 200 && code === 200 && reply?.data?.profile === null)) {
            observed = null;
        } else if (result.status === 200 && code === 200 && result.connectionId && accountId) {
            observed = { deviceId: device.id, connectionId: result.connectionId, accountId };
        } else {
            throw new OnlineProviderError('unavailable', `The shared NetEase sign-in check could not confirm a session (HTTP ${result.status})`, 'netease');
        }
    }
    if (route === '/logout' && result.status === 200) {
        statusSequence += 1;
        observed = null;
    }
    return Response.json(result.body, { status: result.status });
};

// Startup playback and the account reader share a probe before using the Worker session.
const readSharedStatus = (endpoint: string) => {
    const device = getSharedLoginState().device;
    if (!device) return sendSharedNetease(endpoint);
    if (statusRequest?.device === device && statusRequest.sequence === statusSequence) {
        return statusRequest.pending;
    }
    const sequence = ++statusSequence;
    const pending = withOnlineRequestLimit(signal => sendSharedNetease(endpoint, signal), 15_000).finally(() => {
        if (statusRequest?.pending === pending) statusRequest = null;
    });
    statusRequest = { device, sequence, pending };
    return pending;
};

export const requestSharedNetease = async (endpoint: string, signal?: AbortSignal): Promise<Response> => {
    const route = endpoint.split('?')[0];
    const device = getSharedLoginState().device;
    if (route === '/login/status' || (route === '/song/url/v1' && device && observed?.deviceId !== device.id)) {
        const status = readSharedStatus(route === '/login/status' ? endpoint : '/login/status');
        const sequence = statusSequence;
        const response = await status;
        signal?.throwIfAborted();
        if (sequence !== statusSequence || getSharedLoginState().device !== device) {
            throw new OnlineProviderError('unavailable', 'A newer NetEase account check replaced this request', 'netease');
        }
        if (route === '/login/status') return response.clone();
    }
    return sendSharedNetease(endpoint, signal);
};
