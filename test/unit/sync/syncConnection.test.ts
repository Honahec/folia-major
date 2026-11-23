import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectSyncConfig } from '../../../src/services/sync/syncClient';

// Lock enrollment to the device returned by the request that used this person's token.

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.resetModules());

it.each(['network failure', 'HTTP 503'] as const)('keeps desktop enrollment after a temporary discovery %s', async failure => {
    const origin = 'https://folia.example';
    const device = { id: 'desktop', label: 'Mac' };
    const requestSharedLogin = vi.fn();
    if (failure === 'network failure') requestSharedLogin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    else requestSharedLogin.mockResolvedValueOnce({ status: 503, body: { error: 'shared_login_unavailable' } });
    requestSharedLogin.mockResolvedValueOnce({ status: 200, body: { ...device, providers: ['netease'] } });
    vi.stubGlobal('window', { electron: { getSharedLoginOrigin: () => Promise.resolve(origin), requestSharedLogin } });
    const { initializeSharedLogin, getSharedLoginState } = await import('../../../src/services/sync/sharedLoginClient');
    await initializeSharedLogin();
    expect(getSharedLoginState()).toMatchObject({ origin, device: null, discoveryUnavailable: true });
    expect(getSharedLoginState().deviceLost).toBeFalsy();
    await initializeSharedLogin();
    expect(getSharedLoginState()).toMatchObject({ origin, device, deviceLost: false });
    expect(getSharedLoginState().discoveryUnavailable).toBeFalsy();
});

it('keeps a rejected device session distinct from a temporary discovery failure', async () => {
    const origin = 'https://folia.example';
    vi.stubGlobal('window', {
        electron: {
            getSharedLoginOrigin: () => Promise.resolve(origin),
            requestSharedLogin: () => Promise.resolve({ status: 401, body: { error: 'device_required' } }),
        },
    });
    const { initializeSharedLogin, getSharedLoginState } = await import('../../../src/services/sync/sharedLoginClient');
    await initializeSharedLogin();
    expect(getSharedLoginState()).toMatchObject({ origin, device: null, deviceLost: true });
    expect(getSharedLoginState().discoveryUnavailable).toBeFalsy();
});

it('retries when desktop credentials are temporarily unreadable at startup', async () => {
    const origin = 'https://folia.example';
    const device = { id: 'desktop', label: 'Mac' };
    const getSharedLoginOrigin = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(origin);
    const requestSharedLogin = vi.fn().mockResolvedValue({ status: 200, body: { ...device, providers: ['netease'] } });
    vi.stubGlobal('window', {
        electron: { getSharedLoginOrigin, requestSharedLogin },
        localStorage: { getItem: () => JSON.stringify({ workerBaseUrl: origin, deviceId: device.id }) },
    });
    const { initializeSharedLogin, getSharedLoginState } = await import('../../../src/services/sync/sharedLoginClient');
    await initializeSharedLogin();
    expect(getSharedLoginState()).toMatchObject({ origin, device: null, discoveryUnavailable: true });
    expect(getSharedLoginState().deviceLost).toBeFalsy();
    expect(requestSharedLogin).not.toHaveBeenCalled();
    await initializeSharedLogin();
    expect(getSharedLoginState()).toMatchObject({ origin, device, deviceLost: false });
    expect(getSharedLoginState().discoveryUnavailable).toBeFalsy();
});

it('waits for the current discovery when an older response arrives first', async () => {
    const origin = 'https://folia.example';
    let older: (value: unknown) => void = () => {};
    let newer: (value: unknown) => void = () => {};
    const requestSharedLogin = vi.fn()
        .mockReturnValueOnce(new Promise(resolve => { older = resolve; }))
        .mockReturnValueOnce(new Promise(resolve => { newer = resolve; }));
    vi.stubGlobal('window', { electron: { getSharedLoginOrigin: () => Promise.resolve(origin), requestSharedLogin } });
    const { initializeSharedLogin, getSharedLoginState } = await import('../../../src/services/sync/sharedLoginClient');
    const first = initializeSharedLogin();
    await vi.waitFor(() => expect(requestSharedLogin).toHaveBeenCalledTimes(1));
    const second = initializeSharedLogin(true);
    await vi.waitFor(() => expect(requestSharedLogin).toHaveBeenCalledTimes(2));
    const settled = vi.fn();
    void first.then(settled);
    older({ status: 200, body: { id: 'old', label: 'Old' } });
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).not.toHaveBeenCalled();
    newer({ status: 200, body: { id: 'current', label: 'Current' } });
    await Promise.all([first, second]);
    expect(getSharedLoginState().device?.id).toBe('current');
});

it('caches a missing Worker route on an unenrolled Web build', async () => {
    const origin = 'https://folia.example';
    const fetch = vi.fn(() => Promise.resolve(Response.json({}, { status: 404 })));
    vi.stubGlobal('window', { location: { origin } });
    vi.stubGlobal('fetch', fetch);
    const { initializeSharedLogin } = await import('../../../src/services/sync/sharedLoginClient');
    await initializeSharedLogin();
    await initializeSharedLogin();
    expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects another tab’s device if the browser session changes during enrollment', async () => {
    const origin = 'https://folia.example';
    vi.stubGlobal('window', { location: { origin } });
    vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(Response.json({ ok: true, backend: 'folia-worker-sync' }))
        .mockResolvedValueOnce(Response.json({ id: 'enrolled', label: 'Test' }, { status: 201 }))
        .mockResolvedValueOnce(Response.json({ id: 'different', label: 'Test', accountId: 'other-user' })));
    await expect(connectSyncConfig({
        provider: 'sync-server', enabled: true, workerBaseUrl: origin, authToken: 'a'.repeat(64),
    }, 'Test')).rejects.toMatchObject({ status: 409 });
});
