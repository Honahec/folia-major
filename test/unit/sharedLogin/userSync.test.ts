import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildThemeBucketSummaries } from '../../../src/services/sync/syncMerkle';
import { createSharedLoginRoutes } from '../../../worker/sharedLogin/routes';
import { openSharedLoginDb } from './sqlite';

// Exercise the real D1 schema and the same device authentication used for music accounts.

const app = createSharedLoginRoutes([]);
const origin = 'https://folia.example/api/shared-login';
let database: ReturnType<typeof openSharedLoginDb>;

beforeEach(() => {
    database = openSharedLoginDb('0002_provider_sessions', '0003_user_sync');
    const insert = database.sqlite.prepare('INSERT INTO shared_login_users VALUES (?, ?)');
    for (const user of ['a', 'b']) insert.run(user, createHash('sha256').update(user.repeat(64)).digest('hex'));
});

afterEach(() => database.sqlite.close());

const send = (path: string, init?: RequestInit) => app.fetch(new Request(origin + path, init), { FOLIA_SHARED_LOGIN_DB: database.db });

const enroll = async (user: string) => {
    const response = await send('/enroll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: user.repeat(64), label: 'test' }),
    });
    const { id, deviceToken } = await response.json() as { id: string; deviceToken: string };
    return (path: string, method = 'GET', body?: unknown) => send(path, {
        method, headers: { Authorization: `Bearer ${deviceToken}`, 'X-Folia-Device': id, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
};

describe('unified Worker sync', () => {
    it('shares appearance across one user’s devices while isolating other users', async () => {
        const a = await enroll('a');
        const anotherA = await enroll('a');
        const b = await enroll('b');
        const record = { schemaVersion: 1, updatedAt: '2026-11-22T10:00:00.000Z', data: { backgroundOpacity: 0.5 } };
        expect((await send('/sync/settings')).status).toBe(401);
        expect((await a('/sync/settings', 'PUT', record)).status).toBe(200);
        expect(await (await anotherA('/sync/settings')).json()).toEqual(record);
        expect(await (await b('/sync/settings')).json()).toBeNull();
        await a('/device', 'DELETE');
        expect((await a('/sync/settings')).status).toBe(401);
        expect(await (await anotherA('/sync/settings')).json()).toEqual(record);
    });

    it('keeps theme summaries accurate through retries and scoped reads', async () => {
        const a = await enroll('a');
        const b = await enroll('b');
        const theme = { fingerprint: 'one', theme: { color: 'blue' }, source: 'manual', updatedAt: '2026-11-22T10:00:00.000Z' };
        const updated = { ...theme, updatedAt: '2026-11-22T11:00:00.000Z' };
        const sameTimeInAnotherZone = { ...theme, updatedAt: '2026-11-22T12:00:00+02:00' };
        expect(await (await a('/sync/themes/put', 'POST', { themes: [sameTimeInAnotherZone, updated, theme] })).json()).toMatchObject({ ok: true });
        await b('/sync/themes/put', 'POST', { themes: [{ ...theme, theme: { color: 'red' } }] });
        expect(await (await a('/sync/themes/manifest')).json()).toMatchObject({ buckets: buildThemeBucketSummaries([updated]) });
        expect(await (await b('/sync/themes/manifest')).json()).toMatchObject({ buckets: buildThemeBucketSummaries([theme]) });
        expect(await (await a('/sync/themes/get', 'POST', { fingerprints: ['one'] })).json()).toEqual({ themes: [updated] });
        expect(await (await a('/sync/state')).json()).toMatchObject({ themeCount: 1 });
    });
});
