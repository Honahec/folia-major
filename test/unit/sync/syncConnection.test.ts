import { afterEach, expect, it, vi } from 'vitest';
import { connectSyncConfig } from '../../../src/services/sync/syncClient';

// Lock enrollment to the device returned by the request that used this person's token.

afterEach(() => vi.unstubAllGlobals());

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
