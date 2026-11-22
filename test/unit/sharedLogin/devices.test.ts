import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withoutSharedLoginCookie } from '../../../worker/sharedLogin/devices';
import { createSharedLoginRoutes } from '../../../worker/sharedLogin/routes';
import { openSharedLoginDb } from './sqlite';

// Check browser and desktop enrollment against the same database.

const { fetch: handleSharedLogin } = createSharedLoginRoutes([]);
const origin = 'https://folia.example';
const aliceToken = 'a'.repeat(64);
const bobToken = 'b'.repeat(64);
let database: ReturnType<typeof openSharedLoginDb>;

beforeEach(() => {
    database = openSharedLoginDb();
    const insert = database.sqlite.prepare('INSERT INTO shared_login_users VALUES (?, ?)');
    insert.run('alice', createHash('sha256').update(aliceToken).digest('hex'));
    insert.run('bob', createHash('sha256').update(bobToken).digest('hex'));
});

afterEach(() => database.sqlite.close());

const request = (path: string, init?: RequestInit) =>
    handleSharedLogin(new Request(`${origin}/api/shared-login${path}`, init), { FOLIA_SHARED_LOGIN_DB: database.db });

const enroll = (token: string, label: string, headers?: Record<string, string>) => request('/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ token, label }),
});

describe('shared login devices', () => {
    it('hands a browser an HttpOnly cookie and refuses cross-origin enrollment', async () => {
        const response = await enroll(aliceToken, 'PWA', { Origin: origin });
        expect(response.status).toBe(201);
        expect(await response.json()).not.toHaveProperty('deviceToken');
        const cookie = response.headers.get('Set-Cookie') ?? '';
        expect(cookie).toContain('__Host-folia-device=');
        expect(cookie).toContain('Path=/; Secure; HttpOnly; SameSite=Strict');
        const publicRequest = new Request(`${origin}/api/lyric-proxy`, {
            headers: { Cookie: `${cookie.split(';')[0]}; other=value` },
        });
        expect(withoutSharedLoginCookie(publicRequest).headers.get('Cookie')?.trim()).toBe('other=value');
        const status = await request('/device', { headers: { Cookie: cookie.split(';')[0] } });
        expect(await status.json()).toMatchObject({ label: 'PWA' });
        expect((await enroll(aliceToken, 'PWA', { Origin: 'https://other.example' })).status).toBe(403);
    });

    it('scopes device lists and revocation to the signed-in user', async () => {
        const alice = await (await enroll(aliceToken, 'Mac')).json();
        const linux = await (await enroll(aliceToken, 'Linux')).json();
        const bob = await (await enroll(bobToken, 'Bob')).json();
        const bearer = (device: { id: string; deviceToken: string }) => ({
            Authorization: `Bearer ${device.deviceToken}`, 'X-Folia-Device': device.id,
        });
        const list = await request('/devices', { headers: bearer(alice) });
        expect(await list.json()).toEqual({ devices: [{ id: linux.id, label: 'Linux' }, { id: alice.id, label: 'Mac' }] });
        await request(`/devices/${bob.id}`, { method: 'DELETE', headers: bearer(alice) });
        expect((await request('/device', { headers: bearer(bob) })).status).toBe(200);
        const staleHeaders = { ...bearer(bob), 'X-Folia-Device': alice.id };
        expect((await request('/device', { method: 'DELETE', headers: staleHeaders })).status).toBe(409);
        expect((await request('/device', { headers: bearer(bob) })).status).toBe(200);
        await request(`/devices/${linux.id}`, { method: 'DELETE', headers: bearer(alice) });
        expect((await request('/device', { headers: bearer(linux) })).status).toBe(401);
        expect((await request('/device', { headers: bearer(alice) })).status).toBe(200);
        expect((await enroll('c'.repeat(64), 'Unknown')).status).toBe(401);
    });
});
