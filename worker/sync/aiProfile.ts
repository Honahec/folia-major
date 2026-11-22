import { parseAiSyncProfile } from '../../shared/ai/syncProfile.cjs';
import { sharedLoginError, sharedLoginJson, type SharedLoginDb, type SharedLoginDevice } from '../sharedLogin/devices.ts';

// Keep AI settings and credentials in a separate encrypted account record.

export type AiProfileEnv = { FOLIA_AI_SYNC_SECRET?: string };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const hex = (value: Uint8Array) => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
const fromHex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], pair => Number.parseInt(pair, 16));

const getEncryptionKey = (secret: string) =>
    crypto.subtle.importKey('raw', fromHex(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);

const additionalData = (userId: string, revision: number) =>
    encoder.encode(JSON.stringify(['folia-sync-ai-v1', userId, revision]));

const readRow = (db: SharedLoginDb, userId: string) => db.prepare(
    'SELECT revision, sealed_profile FROM sync_ai_settings WHERE user_id = ?',
).bind(userId).first<{ revision: number; sealed_profile: string }>();

export const readAiProfile = async (db: SharedLoginDb, userId: string, env: AiProfileEnv) => {
    const secret = env.FOLIA_AI_SYNC_SECRET;
    if (!secret || !/^[a-f0-9]{64}$/.test(secret)) return null;
    const row = await readRow(db, userId);
    if (!row) return null;
    const value = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: fromHex(row.sealed_profile.slice(0, 24)), additionalData: additionalData(userId, row.revision),
    }, await getEncryptionKey(secret), fromHex(row.sealed_profile.slice(24)));
    const profile = parseAiSyncProfile(JSON.parse(decoder.decode(value)) as unknown);
    if (!profile) throw new Error('Invalid stored AI profile');
    return { revision: row.revision, profile };
};

export const handleAiProfile = async (request: Request, db: SharedLoginDb, device: SharedLoginDevice, env: AiProfileEnv) => {
    // Only a desktop session uses this route. Cookie-authenticated browser requests can run AI
    // operations but never receive the credentials.
    if (!/^Bearer [a-f0-9]{64}$/i.test(request.headers.get('Authorization') ?? '')
        || request.headers.has('Origin') || request.headers.has('Sec-Fetch-Site')) {
        return sharedLoginError('desktop_session_required', 403);
    }
    const secret = env.FOLIA_AI_SYNC_SECRET;
    if (!secret || !/^[a-f0-9]{64}$/.test(secret)) return sharedLoginError('ai_sync_unavailable', 503);
    if (request.method === 'GET') return sharedLoginJson(await readAiProfile(db, device.userId, env));
    if (request.method !== 'POST') return sharedLoginError('method_not_allowed', 405);

    const raw = await request.text();
    if (raw.length > 24_000) return sharedLoginError('invalid_ai_settings', 400);
    const data: unknown = await new Response(raw).json().catch(() => null);
    if (typeof data !== 'object' || data === null || !('revision' in data) || !('profile' in data)
        || typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision) || data.revision < 0 || data.revision === Number.MAX_SAFE_INTEGER) {
        return sharedLoginError('invalid_ai_settings', 400);
    }
    const incoming = parseAiSyncProfile(data.profile);
    if (!incoming) return sharedLoginError('invalid_ai_settings', 400);

    const revision = data.revision + 1;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({
        name: 'AES-GCM', iv, additionalData: additionalData(device.userId, revision),
    }, await getEncryptionKey(secret), encoder.encode(JSON.stringify(incoming)));
    const sealed = hex(iv) + hex(new Uint8Array(encrypted));
    const result = await db.prepare(`
        INSERT INTO sync_ai_settings (user_id, revision, sealed_profile)
        SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM shared_login_devices WHERE id = ? AND user_id = ? AND expires_at > ?)
            AND (? = 0 OR EXISTS (SELECT 1 FROM sync_ai_settings WHERE user_id = ?))
        ON CONFLICT(user_id) DO UPDATE SET revision = excluded.revision, sealed_profile = excluded.sealed_profile
        WHERE sync_ai_settings.revision = ?
    `).bind(device.userId, revision, sealed, device.id, device.userId, Date.now(), data.revision, device.userId, data.revision).run();
    return result.meta.changes === 1 ? sharedLoginJson({ revision }) : sharedLoginError('ai_settings_changed', 409);
};
