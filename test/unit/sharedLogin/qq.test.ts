import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleQqServerlessRequest } from '../../../worker/qq';
import { sharedQqProvider } from '../../../worker/qq/sharedLogin';
import { createSharedLoginRoutes } from '../../../worker/sharedLogin/routes';
import { openSharedLoginDb } from './sqlite';

// Exercise provider linking and renewal with a simulated upstream and real SQL.

vi.mock('../../../worker/qq', () => ({ handleQqServerlessRequest: vi.fn() }));

const { fetch: handleSharedLogin, scheduled: refreshSharedLogin } = createSharedLoginRoutes([sharedQqProvider]);
const upstream = vi.mocked(handleQqServerlessRequest);
const origin = 'https://folia.example';
const deviceIds = new Map<string, string>();
let database: ReturnType<typeof openSharedLoginDb>;
let env: { FOLIA_SHARED_LOGIN_DB: typeof database.db; QQ_SESSION_SECRET: string };

beforeEach(() => {
    upstream.mockReset();
    deviceIds.clear();
    database = openSharedLoginDb('0002_provider_sessions');
    env = { FOLIA_SHARED_LOGIN_DB: database.db, QQ_SESSION_SECRET: 'test-secret' };
    for (const user of ['a', 'b']) {
        database.sqlite.prepare('INSERT INTO shared_login_users VALUES (?, ?)').run(
            user, createHash('sha256').update(user.repeat(64)).digest('hex'),
        );
    }
});

afterEach(() => database.sqlite.close());

const enroll = async (user: string) => {
    const response = await handleSharedLogin(new Request(`${origin}/api/shared-login/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.repeat(64), label: 'Desktop' }),
    }), env);
    const { deviceToken, id } = await response.json() as { deviceToken: string; id: string };
    deviceIds.set(deviceToken, id);
    return deviceToken;
};

const send = (path: string, token: string, method = 'GET', connectionId = '') => handleSharedLogin(
    new Request(`${origin}/api/shared-login/qq${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'X-QQ-Session': 'untrusted', 'X-Folia-Device': deviceIds.get(token) ?? '', 'X-Folia-Connection': connectionId },
    }),
    env,
);

const startQr = async (device: string) => {
    upstream.mockResolvedValueOnce(Response.json({ data: { unikey: 'remote-key' } }));
    const result = await send('/login/qr/key?channel=wechat', device);
    return (await result.json() as { data: { unikey: string } }).data.unikey;
};

describe('shared QQ account', () => {
    it('lets linked devices use the sealed session and omits it from every response', async () => {
        const first = await enroll('a');
        const second = await enroll('a');
        const outsider = await enroll('b');
        const key = await startQr(first);
        expect(key).not.toBe('remote-key');
        expect(await (await send(`/login/qr/check?key=${key}`, second)).json()).toEqual({ code: 800 });
        upstream.mockResolvedValueOnce(Response.json({ code: 803, cookie: 'qqmusic_session=qq1.a.sealed' }, {
            headers: { 'Set-Cookie': 'qqmusic_session=qq1.a.sealed' },
        }));
        const confirmed = await send(`/login/qr/check?key=${key}`, first);
        expect(await confirmed.json()).toEqual({ code: 803 });
        expect(confirmed.headers.get('Set-Cookie')).toBeNull();

        upstream.mockResolvedValueOnce(Response.json({ data: { profile: { id: 123 } } }));
        expect((await send('/login/status?cookie=untrusted', second)).status).toBe(200);
        const request = upstream.mock.calls.at(-1)?.[0];
        expect(request?.headers.get('X-QQ-Session')).toBe('qq1.a.sealed');
        expect(upstream.mock.calls.at(-1)?.[2]).toBe('');
        expect((await send('/login/status', outsider)).status).toBe(401);
        expect((await send('/login/refresh', second, 'POST')).status).toBe(404);
        expect(await (await send(`/login/qr/check?key=${key}`, first)).json()).toEqual({ code: 803 });
        expect((await send('/user/playlist', second, 'GET', 'old')).status).toBe(409);
        expect((await send('/user/song/like', second, 'POST', 'old')).status).toBe(409);
        expect((await send('/connection', second, 'DELETE', 'old')).status).toBe(409);
        expect((await send('/connection', second, 'DELETE', key)).status).toBe(200);
        expect((await send('/login/status', first)).status).toBe(401);
    });

    it('prevents an older in-flight QR response from replacing a newer sign-in', async () => {
        const first = await enroll('a');
        const second = await enroll('a');
        const key = await startQr(first);
        let markStarted: () => void = () => {};
        let finishQr: (response: Response) => void = () => {};
        const started = new Promise<void>(resolve => { markStarted = resolve; });
        const upstreamResponse = new Promise<Response>(resolve => { finishQr = resolve; });
        upstream.mockImplementationOnce(() => {
            markStarted();
            return upstreamResponse;
        });
        const pending = send(`/login/qr/check?key=${key}`, first);
        await started;
        const replacement = await startQr(second);
        expect(replacement).not.toBe(key);
        finishQr(Response.json({ code: 803, cookie: 'qqmusic_session=qq1.a.late' }));
        expect(await (await pending).json()).toEqual({ code: 800 });
        expect((await send('/login/status', first)).status).toBe(401);
    });

    it('rotates once when two Worker cron runs overlap', async () => {
        database.sqlite.prepare(`
            INSERT INTO shared_provider_sessions (user_id, provider, sealed_token) VALUES ('a', 'qq', ?)
        `).run('qq1.a.old');
        upstream.mockResolvedValueOnce(Response.json({ data: { rotated: true, token: 'qq1.a.new' } }));
        await Promise.all([refreshSharedLogin(env), refreshSharedLogin(env)]);
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(database.sqlite.prepare('SELECT sealed_token FROM shared_provider_sessions').get()).toEqual({
            sealed_token: 'qq1.a.new',
        });
    });
});
