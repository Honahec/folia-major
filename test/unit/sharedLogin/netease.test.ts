import { createHash, generateKeyPairSync } from 'node:crypto';
import upstreamCrypto from '@neteasecloudmusicapienhanced/api/util/crypto.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sharedNeteaseProvider } from '../../../worker/netease/sharedLogin';
import { openCookie } from '../../../worker/netease/sharedUpstream';
import { createSharedLoginRoutes } from '../../../worker/sharedLogin/routes';
import { openSharedLoginDb } from './sqlite';

// Exercise the same routes and database queries used by a deployed Worker.

const app = createSharedLoginRoutes([sharedNeteaseProvider]);
const upstream = vi.fn<typeof fetch>();
const host = 'https://folia.example/api/shared-login';
let database: ReturnType<typeof openSharedLoginDb>;
let env: { FOLIA_SHARED_LOGIN_DB: typeof database.db; NETEASE_SESSION_SECRET: string };

beforeEach(() => {
    database = openSharedLoginDb('0002_provider_sessions');
    env = {
        FOLIA_SHARED_LOGIN_DB: database.db,
        NETEASE_SESSION_SECRET: 'e'.repeat(64),
    };
    const insert = database.sqlite.prepare('INSERT INTO shared_login_users VALUES (?, ?)');
    for (const id of ['a', 'b']) insert.run(id, createHash('sha256').update(id.repeat(64)).digest('hex'));
    upstream.mockReset();
    vi.stubGlobal('fetch', upstream);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    database.sqlite.close();
});

const enroll = async (user: string): Promise<{ id: string; deviceToken: string }> => {
    const response = await app.fetch(new Request(`${host}/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.repeat(64), label: 'Test device' }),
    }), env);
    return await response.json() as { id: string; deviceToken: string };
};

const send = (device: { id: string; deviceToken: string }, path: string, connection?: string, method = 'GET') => {
    const headers = new Headers({ Authorization: `Bearer ${device.deviceToken}`, 'X-Folia-Device': device.id });
    if (connection) headers.set('X-Folia-Connection', connection);
    return app.fetch(new Request(`${host}${path}`, { method, headers }), env);
};

const start = async (device: { id: string; deviceToken: string }) => {
    upstream.mockResolvedValueOnce(Response.json({ code: 200, unikey: 'upstream-key' }));
    const response = await send(device, '/netease/login/qr/key');
    return (await response.json() as { data: { unikey: string } }).data.unikey;
};

const confirm = async (device: { id: string; deviceToken: string }, key: string, credential: string) => {
    upstream.mockResolvedValueOnce(Response.json({
        code: 803,
    }, { headers: [
        ['Set-Cookie', `MUSIC_U=${credential}; Secure; HttpOnly`],
        ['Set-Cookie', '__csrf=csrf-value; Path=/'],
    ] }));
    return send(device, `/netease/login/qr/check?key=${key}`);
};

describe('shared NetEase account', () => {
    it('keeps the QR attempt and encrypted session scoped, uses the account for playback, and strips credentials', async () => {
        const first = await enroll('a');
        const second = await enroll('a');
        const outsider = await enroll('b');
        expect(await (await send(second, '/device')).json()).toMatchObject({ providers: ['netease'] });

        expect(await (await send(second, '/netease/connection')).json()).toEqual({ connectionId: null });
        const attempt = await start(first);
        expect(attempt).not.toBe('upstream-key');
        const keyHeaders = new Headers(upstream.mock.lastCall?.[1]?.headers);
        const image = await send(first, `/netease/login/qr/create?key=${attempt}`);
        expect(await image.json()).toMatchObject({ code: 200, data: { qrimg: expect.stringMatching(/^data:image\/png;base64,/) } });
        upstream.mockResolvedValueOnce(Response.json({ code: 801 }));
        expect(await (await send(first, `/netease/login/qr/check?key=${attempt}`)).json()).toEqual({ code: 801 });
        expect(new Headers(upstream.mock.lastCall?.[1]?.headers).get('Cookie')).toBe(keyHeaders.get('Cookie'));
        expect(await (await send(second, `/netease/login/qr/check?key=${attempt}`)).json()).toEqual({ code: 800 });
        const response = await confirm(first, attempt, 'account-secret');
        expect(await response.json()).toEqual({ code: 803 });
        expect(response.headers.get('Set-Cookie')).toBeNull();
        expect(await (await send(second, '/netease/connection')).json()).toEqual({ connectionId: attempt });
        expect(await (await send(outsider, '/netease/connection')).json()).toEqual({ connectionId: null });
        expect(await (await send(first, `/netease/login/qr/check?key=${attempt}`)).json()).toEqual({ code: 803 });

        const saved = database.sqlite.prepare("SELECT sealed_token FROM shared_provider_sessions WHERE user_id = 'a'").get();
        expect(saved?.sealed_token).not.toContain('account-secret');
        await expect(openCookie(env, 'b', String(saved?.sealed_token))).resolves.toBeNull();
        const proxyHeaders = new Headers({ 'Set-Cookie': 'MUSIC_U=another-secret' });
        upstream.mockResolvedValueOnce(Response.json({
            code: 200, profile: { userId: 321, cookie: 'secret' }, MUSIC_U: 'secret',
        }, { headers: proxyHeaders }));
        const status = await send(second, '/netease/login/status?cookie=untrusted');
        expect(status.headers.get('X-Folia-Connection')).toBe(attempt);
        expect(status.headers.get('Set-Cookie')).toBeNull();
        expect(await status.json()).toEqual({ data: { code: 200, profile: { userId: 321 } } });
        expect(new URL(String(upstream.mock.lastCall?.[0])).pathname).toBe('/weapi/w/nuser/account/get');
        const upstreamHeaders = new Headers(upstream.mock.lastCall?.[1]?.headers);
        expect(upstreamHeaders.get('Cookie')).toContain('MUSIC_U=account-secret; __csrf=csrf-value');
        expect(upstreamHeaders.get('Cache-Control')).toBe('no-store');
        expect(upstream.mock.lastCall?.[1]).toMatchObject({ redirect: 'manual', method: 'POST' });
        expect(new URL(String(upstream.mock.lastCall?.[0])).searchParams.has('cookie')).toBe(false);

        const { publicKey } = generateKeyPairSync('x25519');
        vi.spyOn(upstreamCrypto, 'xeapiDecryptPublicKey').mockReturnValue({
            publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
            sk: 'test-public-key', version: 1,
        });
        const encrypt = vi.spyOn(upstreamCrypto, 'xeapi');
        upstream.mockImplementationOnce((_url, init) => {
            const nonce = new URLSearchParams(String(init?.body)).get('nonce') ?? '';
            return Promise.resolve(Response.json({
                code: 200, data: { encryptedData: 'mock', timestamp: '123', signature: upstreamCrypto.xeapiSign('123', nonce) },
            }));
        }).mockResolvedValueOnce(Response.json({ data: [{ url: 'https://media.example/song' }] }));
        const play = await send(second, '/netease/song/url/v1?id=42&level=standard&proxy=https://bad.example&domain=https://bad.example', attempt);
        expect(await play.json()).toEqual({ data: [{ url: 'https://media.example/song' }] });
        const url = new URL(String(upstream.mock.lastCall?.[0]));
        expect(url.href).toBe('https://interface3.music.163.com/xeapi/song/enhance/player/url/v1');
        expect(encrypt.mock.lastCall?.slice(0, 2)).toEqual([
            '/api/song/enhance/player/url/v1', { ids: '[42]', level: 'standard', encodeType: 'flac' },
        ]);
        const [bootstrapUrl, bootstrap] = upstream.mock.calls.at(-2) ?? [];
        expect(bootstrapUrl).toBe('https://interface.music.163.com/api/bsr/sk/get');
        expect(new Headers(bootstrap?.headers).get('Cookie')).not.toContain('MUSIC_U');
        expect(new Headers(upstream.mock.lastCall?.[1]?.headers).get('x-music-u')).toBe('account-secret');
        const requests = upstream.mock.calls.length;
        expect(await (await send(outsider, '/netease/login/status')).json()).toEqual({ code: 200, data: { profile: null } });
        expect((await send(outsider, '/netease/user/account', attempt)).status).toBe(409);
        expect((await send(second, '/netease/like?id=42&like=true', undefined, 'POST')).status).toBe(409);
        expect((await send(second, '/netease/album?id=../../logout', attempt)).status).toBe(404);
        expect(upstream.mock.calls.length).toBe(requests);
    });

    it('keeps a provider refusal distinct from a successful empty list', async () => {
        const device = await enroll('a');
        upstream.mockResolvedValueOnce(Response.json({ code: -462 }));
        const response = await send(device, '/netease/user/playlist?uid=42');
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ code: -462 });
    });

    it('maps a blocked upstream redirect to an error without following it', async () => {
        const device = await enroll('a');
        upstream.mockResolvedValueOnce(Response.redirect('https://other.example', 302));
        const response = await send(device, '/netease/cloudsearch?keywords=test');
        expect(response.status).toBe(502);
        expect(upstream).toHaveBeenCalledTimes(1);
    });

    it('keeps the same connection through renewal and refuses stale requests after re-linking', async () => {
        const first = await enroll('a');
        const second = await enroll('a');
        const old = await start(first);
        await confirm(first, old, 'first');
        database.sqlite.prepare('UPDATE shared_provider_sessions SET refresh_after = 0').run();
        upstream.mockResolvedValueOnce(Response.json({ code: 200 }, { headers: { 'Set-Cookie': 'MUSIC_U=rotated; Secure' } }));
        await Promise.all([app.scheduled(env), app.scheduled(env)]);
        expect(upstream.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith('/login/token/refresh'))).toHaveLength(1);
        const renewed = database.sqlite.prepare('SELECT sealed_token, connection_id FROM shared_provider_sessions').get();
        expect(renewed?.connection_id).toBe(old);
        await expect(openCookie(env, 'a', String(renewed?.sealed_token))).resolves.toContain('MUSIC_U=rotated');

        const replacement = await start(second);
        await confirm(second, replacement, 'new-account');
        expect((await send(first, '/netease/user/playlist?uid=42', old)).status).toBe(409);
        expect((await send(first, '/netease/connection', old, 'DELETE')).status).toBe(409);
        expect((await send(second, '/netease/connection', replacement, 'DELETE')).status).toBe(200);
        expect(await (await send(first, '/netease/connection')).json()).toEqual({ connectionId: null });
    });
});
