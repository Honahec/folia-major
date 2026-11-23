import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A PWA can restore its last song while Omni is still loading the shared account.

const device = { id: 'device-a', label: 'Installed PWA' };
const connectionId = 'connection-a';
const deviceStatus = () => Response.json({ ...device, accountId: 'folia-user', providers: ['qq'] });
const loginStatus = () => Response.json({ code: 200, data: { profile: { musicid: '123' } } }, {
    headers: { 'X-Folia-Connection': connectionId },
});
const audio = () => Response.json({ data: { playUrl: { 'song-mid': { url: 'https://audio.example/song' } } } });

const deferred = <T,>() => {
    let finish: (value: T) => void = () => {};
    const promise = new Promise<T>(resolve => { finish = resolve; });
    return { promise, resolve: finish };
};

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { location: { origin: 'https://folia.example' } });
});

afterEach(() => vi.unstubAllGlobals());

describe('shared QQ playback while starting the PWA', () => {
    it.each([true, false])('waits for one account check even when playback starts first = %s', async playbackFirst => {
        const urls: string[] = [];
        const started = deferred<void>();
        const confirmed = deferred<Response>();
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            const path = new URL(url, 'https://folia.example').pathname.replace('/api/shared-login', '');
            urls.push(path);
            if (path === '/device') return deviceStatus();
            if (path === '/qq/login/status') {
                started.resolve();
                return confirmed.promise.then(response => response.clone());
            }
            if (path === '/qq/getMusicPlay/song-mid') {
                return new Headers(init.headers).get('X-Folia-Connection') === connectionId
                    ? audio()
                    : Response.json({ code: 401, message: 'Login required' }, { status: 401 });
            }
            if (path === '/qq/search') return Response.json({ code: 200 });
            throw new Error('Unexpected test route');
        }));
        const { requestQq } = await import('../../../src/services/onlineMusic/qq/qqTransport');
        const play = () => requestQq('music_play', { songmid: 'song-mid' });
        const status = () => requestQq('login_status');
        const first = Promise.allSettled([playbackFirst ? play() : status()]);
        const second = Promise.allSettled([playbackFirst ? status() : play()]);
        await started.promise;
        try {
            // Public search remains usable while the account check is still waiting.
            await expect(requestQq('search', { key: 'song' })).resolves.toEqual({ code: 200 });
            expect(urls).toEqual(['/device', '/qq/login/status', '/qq/search']);
        } finally {
            confirmed.resolve(loginStatus());
        }
        expect(await first).toEqual([{ status: 'fulfilled', value: await (playbackFirst ? audio() : loginStatus()).json() }]);
        expect(await second).toEqual([{ status: 'fulfilled', value: await (playbackFirst ? loginStatus() : audio()).json() }]);
        expect(urls.at(-1)).toBe('/qq/getMusicPlay/song-mid');
    });

    it.each([200, 401, 503])('preserves the outcome of an unsuccessful login check (HTTP %s)', async status => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url === '/api/shared-login/device') return deviceStatus();
            if (url === '/api/shared-login/qq/login/status') return Response.json({ data: {} }, { status });
            throw new Error('Playback must not run before the account is confirmed');
        });
        vi.stubGlobal('fetch', fetchMock);
        const { requestQq } = await import('../../../src/services/onlineMusic/qq/qqTransport');
        await expect(requestQq('music_play', { songmid: 'song-mid' })).rejects.toMatchObject({
            code: status === 503 ? 'network' : 'auth-required',
            httpStatus: status === 503 ? 503 : 401,
        });
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/shared-login/device', '/api/shared-login/qq/login/status']);
    });

    it('ignores a startup 401 when QR confirmation settles alongside it', async () => {
        const checking = deferred<void>();
        const scanning = deferred<void>();
        const oldStatus = deferred<Response>();
        const qrResult = deferred<Response>();
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            const path = new URL(url, 'https://folia.example').pathname;
            if (path.endsWith('/device')) return deviceStatus();
            if (path.endsWith('/login/status')) {
                checking.resolve();
                return oldStatus.promise;
            }
            if (path.endsWith('/qr/check')) {
                scanning.resolve();
                return qrResult.promise;
            }
            throw new Error('Unexpected test route');
        }));
        const { requestQq } = await import('../../../src/services/onlineMusic/qq/qqTransport');
        const play = expect(requestQq('music_play', { songmid: 'song-mid' })).rejects.toMatchObject({ code: 'unavailable' });
        await checking.promise;
        const confirm = requestQq('login_qr_check', { key: 'scan' });
        await scanning.promise;
        oldStatus.resolve(Response.json({ error: 'provider_sign_in_required' }, { status: 401 }));
        queueMicrotask(() => qrResult.resolve(Response.json({ code: 803 })));
        await expect(confirm).resolves.toEqual({ code: 803 });
        await play;
    });

    it.each(['confirm', 'logout'] as const)('does not accept a status read started before %s', async transition => {
        const started = deferred<void>();
        const staleStatus = deferred<Response>();
        let reads = 0;
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            const path = new URL(url, 'https://folia.example').pathname;
            if (path.endsWith('/device')) return deviceStatus();
            if (path.endsWith('/login/status')) {
                if (transition === 'logout' && reads === 0) {
                    reads++;
                    return loginStatus();
                }
                if (reads++ === (transition === 'logout' ? 1 : 0)) {
                    started.resolve();
                    return staleStatus.promise;
                }
                return transition === 'logout' ? Response.json({ data: {} }, { status: 401 })
                    : Response.json({ data: { profile: { musicid: '456' } } }, {
                        headers: { 'X-Folia-Connection': 'connection-b' },
                    });
            }
            if (path.endsWith('/qr/check')) return Response.json({ code: 803 });
            if (path.endsWith('/connection') && init.method === 'DELETE') {
                expect(new Headers(init.headers).get('X-Folia-Connection')).toBe(connectionId);
                return Response.json({ ok: true });
            }
            if (path.endsWith('/getMusicPlay/song-mid')) {
                expect(new Headers(init.headers).get('X-Folia-Connection')).toBe('connection-b');
                return audio();
            }
            throw new Error('Unexpected test route');
        }));
        const { requestQq } = await import('../../../src/services/onlineMusic/qq/qqTransport');
        if (transition === 'logout') await requestQq('login_status');
        const previous = expect(requestQq('login_status')).rejects.toMatchObject({ code: 'unavailable' });
        await started.promise;
        try {
            if (transition === 'logout') {
                await requestQq('logout');
                await expect(requestQq('login_status')).rejects.toMatchObject({ code: 'auth-required' });
            } else {
                await requestQq('login_qr_check', { key: 'scan' });
                await expect(requestQq('login_status')).resolves.toMatchObject({ data: { profile: { musicid: '456' } } });
            }
        } finally {
            staleStatus.resolve(loginStatus());
            await previous;
        }
        if (transition === 'confirm') await expect(requestQq('music_play', { songmid: 'song-mid' })).resolves.toEqual(await audio().json());
    });
});
