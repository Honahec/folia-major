import { expect, it, vi } from 'vitest';
import { createAiCredentialStore } from '../../../electron/aiCredentialStore.cjs';
import { createAiProfileSync } from '../../../electron/sharedLogin/aiProfile.cjs';

// Desktop AI sync preserves the saved key's binding and does not carry it into a new account.

const makeDesktop = (worker: { accountId: string; revision: number; profile: unknown; unavailable?: boolean }) => {
    const values = new Map<string, unknown>();
    const store = {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value),
        delete: (key: string) => values.delete(key),
    };
    const safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
    };
    const credentials = createAiCredentialStore({ store, safeStorage, platform: 'darwin', warn: vi.fn() });
    const device = {
        aiProfileClient: async () => ({
            accountId: worker.accountId,
            isCurrent: () => true,
            request: async (method: string, body?: string) => {
                if (worker.unavailable) return { status: 503 };
                if (method === 'GET') {
                    return { status: 200, body: worker.revision ? { revision: worker.revision, profile: worker.profile } : null };
                }
                const change = JSON.parse(body ?? '{}') as { profile: unknown; revision: number };
                if (change.revision !== worker.revision) return { status: 409 };
                worker.profile = change.profile;
                return { status: 200, body: { revision: ++worker.revision } };
            },
        }),
    };
    return { store, credentials, sync: createAiProfileSync({ store, credentials, device }) };
};

it('preserves endpoint-bound keys when switching the URL, and isolates an empty new account', async () => {
    const worker = { accountId: 'first', revision: 0, profile: null as unknown };
    const source = makeDesktop(worker);
    const receiver = makeDesktop(worker);
    const origin = 'https://folia.example';
    source.store.set('OPENAI_API_URL', 'https://api.openai.com/v1');
    source.credentials.set('OPENAI_API_KEY', 'test-key');
    expect(await source.sync.sync(origin, 'device-a')).toEqual({ status: 'uploaded' });
    source.store.set('OPENAI_API_URL', 'https://api.deepseek.com/v1');
    source.sync.markChanged('OPENAI_API_URL');
    expect(await source.sync.sync(origin, 'device-a')).toEqual({ status: 'uploaded' });
    expect(await receiver.sync.sync(origin, 'device-b')).toEqual({ status: 'applied' });
    expect(receiver.credentials.get('OPENAI_API_KEY')).toBe('');
    receiver.store.set('OPENAI_API_URL', 'https://api.openai.com/v1');
    expect(receiver.credentials.get('OPENAI_API_KEY')).toBe('test-key');

    worker.accountId = 'second';
    worker.revision = 0;
    worker.profile = null;
    expect(await receiver.sync.sync(origin, 'device-b')).toEqual({ status: 'applied' });
    expect(receiver.credentials.get('OPENAI_API_KEY')).toBe('');
    expect(worker.profile).toBeNull();
    receiver.credentials.set('GEMINI_API_KEY', 'new-account-key');
    receiver.sync.markChanged('GEMINI_API_KEY');
    expect(await receiver.sync.sync(origin, 'device-b')).toEqual({ status: 'uploaded' });
    expect(worker.profile).toMatchObject({ GEMINI_API_KEY: 'new-account-key', OPENAI_API_KEY: '' });
});

it('keeps ownership of local keys when the first enrolled account has AI sync unavailable', async () => {
    const worker = { accountId: 'first', revision: 0, profile: null as unknown, unavailable: true };
    const desktop = makeDesktop(worker);
    const origin = 'https://folia.example';
    desktop.credentials.set('GEMINI_API_KEY', 'first-account-key');
    expect(await desktop.sync.sync(origin, 'device-a')).toEqual({ status: 'unavailable' });
    worker.accountId = 'second';
    worker.unavailable = false;
    expect(await desktop.sync.sync(origin, 'device-b')).toEqual({ status: 'applied' });
    expect(worker.profile).toBeNull();
    expect(desktop.credentials.get('GEMINI_API_KEY')).toBe('');
});

it('merges a locally cleared key with another device’s model change', async () => {
    const worker = { accountId: 'alice', revision: 0, profile: null as unknown };
    const a = makeDesktop(worker);
    const b = makeDesktop(worker);
    const origin = 'https://folia.example';
    a.credentials.set('GEMINI_API_KEY', 'key-to-clear');
    await a.sync.sync(origin, 'desktop-a');
    await b.sync.sync(origin, 'desktop-b');
    a.credentials.set('GEMINI_API_KEY', '');
    a.sync.markChanged('GEMINI_API_KEY');
    b.store.set('GEMINI_API_MODEL', 'new-model');
    b.sync.markChanged('GEMINI_API_MODEL');
    await b.sync.sync(origin, 'desktop-b');
    await a.sync.sync(origin, 'desktop-a');
    expect(worker.profile).toMatchObject({ GEMINI_API_KEY: '', GEMINI_API_MODEL: 'new-model' });
    expect(a.credentials.get('GEMINI_API_KEY')).toBe('');
    expect(a.store.get('GEMINI_API_MODEL')).toBe('new-model');
});

it('saves only draft fields over a profile that changed on another device', async () => {
    const worker = { accountId: 'alice', revision: 0, profile: null as unknown };
    const desktop = makeDesktop(worker);
    desktop.store.set('GEMINI_API_MODEL', 'synced-model');
    desktop.store.set('OPENAI_API_URL', 'https://api.openai.com/v1');
    desktop.credentials.set('OPENAI_API_KEY', 'saved-key');
    expect(desktop.sync.saveLocal({ OPENAI_API_TEMPERATURE: '0.4' })).toBe(true);
    expect(desktop.store.get('GEMINI_API_MODEL')).toBe('synced-model');
    expect(desktop.store.get('OPENAI_API_URL')).toBe('https://api.openai.com/v1');
    expect(desktop.store.get('OPENAI_API_TEMPERATURE')).toBe('0.4');
    expect(desktop.credentials.get('OPENAI_API_KEY')).toBe('saved-key');
});
