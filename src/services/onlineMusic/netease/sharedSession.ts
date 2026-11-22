import { getSharedLoginState, requestSharedLogin } from '../../sync/sharedLoginClient';
import { useOnlineProviderAccountStore } from '../../../stores/useOnlineProviderAccountStore';
import { OnlineProviderError } from '../../../types/onlineMusic';

// Keep a connection identifier with the account shown in Folia. The credential stays in the Worker.

let observed: { deviceId: string; connectionId: string; accountId: string } | null = null;
let statusSequence = 0;
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
    return Boolean((state.device || state.deviceLost) && (state.providers?.includes('netease') ?? true));
};

export const hasSharedNeteaseAccount = (): boolean =>
    Boolean(observed && observed.deviceId === getSharedLoginState().device?.id);

const accountIdFrom = (body: unknown): string | null => {
    const reply = body as { data?: { profile?: { userId?: string | number; id?: string | number } } } | null;
    const id = reply?.data?.profile?.userId ?? reply?.data?.profile?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
};

export const requestSharedNetease = async (endpoint: string, signal?: AbortSignal): Promise<Response> => {
    const device = getSharedLoginState().device;
    if (!device) throw new OnlineProviderError('auth-required', 'Reconnect this device to use the shared sign-in', 'netease');

    const route = endpoint.split('?')[0];
    const status = route === '/login/status';
    if (status) statusSequence += 1;
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
    if (result.status === 409) {
        throw new OnlineProviderError('auth-required', 'The shared NetEase account changed. Refresh the account and try again.', 'netease');
    }
    const reply = result.body as { error?: string; code?: number } | null;
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
    if (status && result.status === 200) {
        const accountId = accountIdFrom(result.body);
        observed = result.connectionId && accountId ? { deviceId: device.id, connectionId: result.connectionId, accountId } : null;
    }
    if (status && [301, 401, 403].includes(result.status)) observed = null;
    if (route === '/logout' && result.status === 200) {
        statusSequence += 1;
        observed = null;
    }
    return Response.json(result.body, { status: result.status });
};
