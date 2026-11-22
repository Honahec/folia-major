import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasSharedNeteaseConnectionChanged, requestSharedNetease, usesSharedNeteaseSession } from '../../../src/services/onlineMusic/netease/sharedSession';
import { neteaseApi } from '../../../src/services/onlineMusic/netease/netease';
import type { SharedLoginState } from '../../../src/services/sync/sharedLoginClient';

// Keep the shared connection on the current device and the most recent account probe.

const { getState, send } = vi.hoisted(() => ({ getState: vi.fn<() => SharedLoginState>(), send: vi.fn() }));

vi.mock('../../../src/services/sync/sharedLoginClient', () => ({
    getSharedLoginState: getState,
    initializeSharedLogin: () => Promise.resolve(),
    requestSharedLogin: send,
}));

const device = { id: 'device', label: 'Test' };
const connected = { available: true, device, origin: 'https://folia.example', providers: ['netease'] };

beforeEach(() => {
    getState.mockReturnValue(connected);
    send.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('NetEase shared client', () => {
    it('rejects a late account probe without replacing the newer connection', async () => {
        let answer: (value: unknown) => void = () => {};
        const late = new Promise(resolve => { answer = resolve; });
        send.mockReturnValueOnce(late);
        send.mockResolvedValueOnce({ status: 200, body: { data: { profile: { userId: 2 } } }, connectionId: 'new' });
        const previous = requestSharedNetease('/login/status');
        await requestSharedNetease('/login/status');
        answer({ status: 200, body: { data: { profile: { userId: 1 } } }, connectionId: 'old' });
        await expect(previous).rejects.toMatchObject({ code: 'unavailable' });
        send.mockResolvedValueOnce({ status: 200, body: { code: 200 } });
        await requestSharedNetease('/user/playlist?uid=2');
        expect(send).toHaveBeenLastCalledWith('/netease/user/playlist?uid=2', 'GET', undefined, undefined, 'new');
    });

    it('does not switch to local credentials when an enrolled server fails discovery', async () => {
        getState.mockReturnValue({ ...connected, device: null, deviceLost: true, providers: undefined });
        expect(usesSharedNeteaseSession()).toBe(true);
        await expect(requestSharedNetease('/like?id=2')).rejects.toMatchObject({ code: 'auth-required' });
        expect(send).not.toHaveBeenCalled();
        getState.mockReturnValue({ ...connected, providers: [] });
        expect(usesSharedNeteaseSession()).toBe(false);
    });

    it('retries a newly observed connection when its account has yet to be shown', async () => {
        send.mockResolvedValueOnce({ status: 200, body: { data: { profile: { userId: 2 } } }, connectionId: 'new-other-device' });
        await requestSharedNetease('/login/status');
        send.mockResolvedValueOnce({ status: 200, body: { connectionId: 'new-other-device' } });
        await expect(hasSharedNeteaseConnectionChanged()).resolves.toBe(true);
        await expect(hasSharedNeteaseConnectionChanged()).resolves.toBe(false);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith('/netease/connection', 'GET', undefined, expect.any(AbortSignal));
    });

    it('reports an account session only while the current device has a live connection', async () => {
        send.mockResolvedValueOnce({ status: 200, body: { data: { profile: { userId: 2 } } }, connectionId: 'last' });
        await requestSharedNetease('/login/status');
        expect(neteaseApi.hasAccountSession()).toBe(true);
        getState.mockReturnValue({ ...connected, device: { id: 'other-device', label: 'Test' } });
        expect(neteaseApi.hasAccountSession()).toBe(false);
        getState.mockReturnValue(connected);
        send.mockResolvedValueOnce({ status: 401, body: { code: 401 } });
        await requestSharedNetease('/login/status');
        expect(neteaseApi.hasAccountSession()).toBe(false);
        send.mockResolvedValueOnce({ status: 200, body: { code: 200 } });
        await requestSharedNetease('/cloudsearch?keywords=hello');
        expect(send).toHaveBeenLastCalledWith('/netease/cloudsearch?keywords=hello', 'GET', undefined, undefined, undefined);
    });

    it('keeps an upstream outage from becoming an empty playlist page', async () => {
        vi.stubGlobal('window', {});
        send.mockResolvedValueOnce({ status: 502, body: { error: 'provider_unreachable' } });
        await expect(neteaseApi.getUserPlaylists(2)).rejects.toMatchObject({ code: 'unavailable' });
    });

    it('reports expired connections for account recovery and does not replay mutations', async () => {
        send.mockResolvedValueOnce({ status: 409, body: { error: 'connection_changed' } });
        await expect(requestSharedNetease('/like?id=2')).rejects.toMatchObject({ code: 'auth-required' });
        expect(send).toHaveBeenCalledTimes(1);
    });
});
