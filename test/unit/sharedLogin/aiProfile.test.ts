import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createSharedLoginRoutes } from '../../../worker/sharedLogin/routes';
import { openSharedLoginDb } from './sqlite';

// The Worker encrypts AI settings, restricts their download to desktop, and checks revisions.

it('isolates accounts and keeps AI credentials out of the browser and database plaintext', async () => {
    const { fetch: route } = createSharedLoginRoutes([]);
    const { db, sqlite } = openSharedLoginDb('0004_ai_settings');
    const env = { FOLIA_SHARED_LOGIN_DB: db, FOLIA_AI_SYNC_SECRET: 'd'.repeat(64) };
    const origin = 'https://folia.example';
    const request = (path: string, init?: RequestInit) => route(new Request(origin + '/api/shared-login' + path, init), env);
    const enroll = async (userId: string, token: string, browser = false) => {
        sqlite.prepare('INSERT OR IGNORE INTO shared_login_users VALUES (?, ?)').run(userId, createHash('sha256').update(token).digest('hex'));
        const response = await request('/enroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(browser ? { Origin: origin } : {}) },
            body: JSON.stringify({ token, label: 'test device' }),
        });
        const { id, deviceToken } = await response.json() as { id: string; deviceToken?: string };
        return {
            'X-Folia-Device': id,
            'Content-Type': 'application/json',
            ...(browser ? { Cookie: response.headers.get('Set-Cookie')!.split(';')[0] }
                : { Authorization: 'Bearer ' + deviceToken }),
        };
    };
    const profile = {
        AI_PROVIDER: 'openai', AI_PROVIDER_PRESET: 'custom', GEMINI_API_MODEL: '', OPENAI_API_MODEL: 'test',
        OPENAI_API_URL: 'http://127.0.0.1:1234', OPENAI_API_KEY_ENDPOINT: 'http://127.0.0.1:1234', OPENAI_API_TEMPERATURE: '0.7', OPENAI_API_STREAM: true,
        GEMINI_API_KEY: 'test-gemini-credential', OPENAI_API_KEY: 'test-openai-credential',
    };
    try {
        const desktop = await enroll('alice', 'a'.repeat(64));
        const browser = await enroll('alice', 'a'.repeat(64), true);
        const second = await enroll('alice', 'a'.repeat(64));
        const unrelated = await enroll('bob', 'b'.repeat(64));
        const save = (revision: number, settings: typeof profile) => request('/ai/settings', {
            method: 'POST', headers: desktop, body: JSON.stringify({ revision, profile: settings }),
        });
        expect((await save(0, profile)).status).toBe(200);
        expect((await save(0, profile)).status).toBe(409);
        expect(await (await request('/ai/settings', { headers: second })).json()).toEqual({ revision: 1, profile });
        expect(await (await request('/ai/settings', { headers: unrelated })).json()).toBeNull();
        expect((await request('/ai/settings', { headers: browser })).status).toBe(403);
        expect((await request('/ai/settings', { headers: { ...browser, Authorization: 'Basic not-a-device-token' } })).status).toBe(403);
        expect((await request('/ai/settings', { headers: { ...desktop, Origin: origin } })).status).toBe(403);
        expect((await request('/ai/theme', { method: 'POST', headers: browser })).status).toBe(422);
        const row = sqlite.prepare('SELECT * FROM sync_ai_settings').get();
        expect(JSON.stringify(row)).not.toContain('test-openai-credential');
        expect((await save(1, { ...profile, OPENAI_API_KEY: '' })).status).toBe(200);
        expect(await (await request('/ai/settings', { headers: second })).json()).toMatchObject({ revision: 2, profile: { OPENAI_API_KEY: '' } });
        expect((await request('/device', { method: 'DELETE', headers: desktop })).status).toBe(200);
        expect((await save(2, profile)).status).toBe(401);
    } finally {
        sqlite.close();
    }
});
