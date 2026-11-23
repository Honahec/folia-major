import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasSharedNeteaseConnectionChanged, requestSharedNetease, usesSharedNeteaseSession } from '../../../src/services/onlineMusic/netease/sharedSession';
import { neteaseProvider } from '../../../src/services/onlineMusic/netease/neteaseProvider';
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

const status = { status: 200, body: { data: { code: 200, profile: { userId: 2 } } }, connectionId: 'new' };

beforeEach(async () => {
    getState.mockReturnValue(connected);
    send.mockReset();
    send.mockResolvedValueOnce({ status: 200, body: { code: 200, data: { profile: null } } });
    await requestSharedNetease('/login/status');
    send.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('NetEase shared client', () => {
    it('waits for the shared account before requesting a playback URL at startup', async () => {
        let answer: (value: unknown) => void = () => {};
        const pending = new Promise(resolve => { answer = resolve; });
        send.mockReturnValueOnce(pending);
        send.mockResolvedValueOnce({ status: 200, body: { code: 200, data: [{ url: 'https://example.test/audio' }] } });
        const audio = requestSharedNetease('/song/url/v1?id=1');
        const check = requestSharedNetease('/login/status');
        expect(send).toHaveBeenCalledTimes(1);
        answer(status);
        await expect((await check).json()).resolves.toEqual(status.body);
        await expect((await audio).json()).resolves.toMatchObject({ data: [{ url: 'https://example.test/audio' }] });
        expect(send).toHaveBeenLastCalledWith('/netease/song/url/v1?id=1', 'GET', undefined, undefined, 'new');
    });

    it.each([
        { status: 200, body: { code: 200, data: { profile: null } } },
        { status: 401, body: { code: 401 } },
    ])('requests audio as a guest after a confirmed sign-out (HTTP $status)', async signOut => {
        send.mockResolvedValueOnce(signOut).mockResolvedValueOnce({ status: 200, body: { code: 200 } });
        await requestSharedNetease('/song/url/v1?id=1');
        expect(send).toHaveBeenLastCalledWith('/netease/song/url/v1?id=1', 'GET', undefined, undefined, undefined);
    });

    it.each([
        { status: 403, body: { error: 'Forbidden' } },
        { status: 200, body: status.body },
    ])('does not fall back to guest audio after an inconclusive check (HTTP $status)', async reply => {
        send.mockResolvedValueOnce(reply);
        await expect(requestSharedNetease('/song/url/v1?id=1')).rejects.toMatchObject({ code: 'unavailable' });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('invalidates an in-flight startup probe after a new QR sign-in', async () => {
        let answer: (value: unknown) => void = () => {};
        send.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }));
        const previous = expect(requestSharedNetease('/login/status')).rejects.toMatchObject({ code: 'unavailable' });
        send.mockResolvedValueOnce({ status: 200, body: { code: 803 } });
        await requestSharedNetease('/login/qr/check?key=new');
        answer(status);
        await previous;
        expect(neteaseApi.hasAccountSession()).toBe(false);
    });

    it('keeps temporary discovery failures separate from account expiry', async () => {
        getState.mockReturnValue({ ...connected, device: null, discoveryUnavailable: true });
        expect(usesSharedNeteaseSession()).toBe(true);
        await expect(requestSharedNetease('/login/status')).rejects.toMatchObject({ code: 'network' });
        expect(send).not.toHaveBeenCalled();
    });

    it('does not treat a contradictory second account check as a confirmed sign-out', async () => {
        vi.stubGlobal('window', {});
        send.mockResolvedValueOnce(status).mockResolvedValueOnce({ status: 401, body: { code: 401 } });
        await expect(neteaseProvider.auth!.getLoginStatus()).rejects.toMatchObject({ code: 'unavailable' });
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
        send.mockResolvedValueOnce({ ...status, connectionId: 'new-other-device' });
        await requestSharedNetease('/login/status');
        send.mockResolvedValueOnce({ status: 200, body: { connectionId: 'new-other-device' } });
        await expect(hasSharedNeteaseConnectionChanged()).resolves.toBe(true);
        await expect(hasSharedNeteaseConnectionChanged()).resolves.toBe(false);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send).toHaveBeenLastCalledWith('/netease/connection', 'GET', undefined, expect.any(AbortSignal));
    });

    it('reports an account session only while the current device has a live connection', async () => {
        send.mockResolvedValueOnce({ ...status, connectionId: 'last' });
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

    it('reports changed connections for account recovery and does not replay mutations', async () => {
        send.mockResolvedValueOnce({ status: 409, body: { error: 'connection_changed' } });
        await expect(requestSharedNetease('/like?id=2')).rejects.toMatchObject({ code: 'unavailable' });
        expect(send).toHaveBeenCalledTimes(1);
    });
});
