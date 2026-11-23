import { getThemeBucketId, hashSyncString, THEME_BUCKET_COUNT } from '../../src/services/sync/syncMerkle.ts';
import { sharedLoginError, sharedLoginJson, type SharedLoginDb } from '../sharedLogin/devices.ts';

// Serve the existing sync protocol using the account picked by the device session.

export const SYNC_HEALTH_PATH = '/api/sync/health';
const schemaVersion = 1;
const maxThemes = 500;

type ThemeRow = { fingerprint: string; theme_json: string; source: string; updated_at: string };

const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isFingerprint = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const themeColumns = 'fingerprint, theme_json, source, updated_at';
const mapTheme = (row: ThemeRow) => ({
    fingerprint: row.fingerprint, theme: JSON.parse(row.theme_json) as unknown, source: row.source, updatedAt: row.updated_at,
});

export const syncHealth = (configured: boolean) => sharedLoginJson(
    { ok: configured, schemaVersion, backend: 'folia-worker-sync' },
    configured ? 200 : 503,
    { 'Access-Control-Allow-Origin': '*' },
);

export const probeSync = async (db?: SharedLoginDb) => {
    if (!db) return syncHealth(false);
    try {
        await db.prepare('SELECT 1 FROM sync_settings LIMIT 1').first();
        return syncHealth(true);
    } catch {
        return syncHealth(false);
    }
};

const getSetting = (db: SharedLoginDb, userId: string) => db.prepare(
    'SELECT value_json, updated_at FROM sync_settings WHERE user_id = ?',
).bind(userId).first<{ value_json: string; updated_at: string }>();

const writeThemes = async (db: SharedLoginDb, userId: string, input: unknown, confirmWrite: boolean) => {
    if (!Array.isArray(input) || input.length > maxThemes) return sharedLoginError('invalid_themes', 400);
    const records = [];
    for (const value of input) {
        const item = object(value);
        if (!item || !isFingerprint(item.fingerprint) || !isTime(item.updatedAt) || !object(item.theme)) {
            return sharedLoginError('invalid_themes', 400);
        }
        const source = item.source === 'auto' || item.source === 'fallback' || item.source === 'edited' ? item.source : 'manual';
        const updatedAt = new Date(item.updatedAt).toISOString();
        records.push([
            item.fingerprint, getThemeBucketId(item.fingerprint), item.theme, source, updatedAt,
            hashSyncString(`${item.fingerprint}\u0000${updatedAt}`),
        ]);
    }
    const { results } = await db.prepare(`
        INSERT INTO sync_themes (user_id, fingerprint, bucket_id, theme_json, source, updated_at, digest)
        SELECT ?, value ->> 0, value ->> 1, value -> 2, value ->> 3, value ->> 4, value ->> 5
        FROM json_each(?) WHERE true
        ON CONFLICT(user_id, fingerprint) DO UPDATE SET
            theme_json = excluded.theme_json, source = excluded.source,
            updated_at = excluded.updated_at, digest = excluded.digest
        WHERE excluded.updated_at >= sync_themes.updated_at
        RETURNING fingerprint
    `).bind(userId, JSON.stringify(records)).all<{ fingerprint: string }>();
    const savedCount = results.length;
    if (confirmWrite && savedCount !== records.length) return sharedLoginError('themes_changed', 409);
    return sharedLoginJson({ ok: true, savedCount });
};

export const handleUserSync = async (request: Request, db: SharedLoginDb, userId: string, path: string): Promise<Response> => {
    const route = `${request.method} ${path}`;
    const body = request.method === 'GET' ? null : object(await request.json().catch(() => null));
    switch (route) {
        case 'GET /health':
            return syncHealth(true);
        case 'GET /state': {
            const [settings, themes] = await Promise.all([
                getSetting(db, userId),
                db.prepare('SELECT MAX(updated_at) AS updatedAt, SUM(count) AS count FROM sync_theme_buckets WHERE user_id = ?')
                    .bind(userId).first<{ updatedAt: string | null; count: number | null }>(),
            ]);
            return sharedLoginJson({ schemaVersion, settingsUpdatedAt: settings?.updated_at ?? null, themesUpdatedAt: themes?.updatedAt ?? null, themeCount: themes?.count ?? 0 });
        }
        case 'GET /settings': {
            const settings = await getSetting(db, userId);
            return sharedLoginJson(settings ? JSON.parse(settings.value_json) as unknown : null);
        }
        case 'PUT /settings': {
            if (body?.schemaVersion !== schemaVersion || !isTime(body.updatedAt) || !object(body.data)) {
                return sharedLoginError('invalid_settings', 400);
            }
            const updatedAt = new Date(body.updatedAt).toISOString();
            const result = await db.prepare(`
                INSERT INTO sync_settings (user_id, value_json, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
                WHERE excluded.updated_at >= sync_settings.updated_at
            `).bind(userId, JSON.stringify({ schemaVersion, updatedAt, data: body.data }), updatedAt).run();
            if (body.confirmWrite === true && result.meta.changes !== 1) return sharedLoginError('settings_changed', 409);
            return sharedLoginJson({ ok: true });
        }
        case 'GET /themes/manifest': {
            const { results } = await db.prepare('SELECT bucket_id, count, digest, updated_at FROM sync_theme_buckets WHERE user_id = ?')
                .bind(userId).all<{ bucket_id: number; count: number; digest: number; updated_at: string }>();
            const entries = new Map(results.map(row => [row.bucket_id, row]));
            const buckets = Array.from({ length: THEME_BUCKET_COUNT }, (_, bucketId) => {
                const row = entries.get(bucketId);
                return { bucketId, count: row?.count ?? 0, hash: String(row?.digest ?? 0), updatedAt: row?.updated_at ?? null };
            });
            return sharedLoginJson({ schemaVersion, bucketCount: THEME_BUCKET_COUNT, buckets });
        }
        case 'POST /themes/put':
            return writeThemes(db, userId, body?.themes, body?.confirmWrite === true);
        case 'POST /themes/get':
        case 'POST /themes/bucket': {
            const byBucket = path === '/themes/bucket';
            const column = byBucket ? 'bucket_id' : 'fingerprint';
            const filter = byBucket
                ? list(body?.bucketIds).filter(value => typeof value === 'number' && Number.isInteger(value)).slice(0, 32)
                : list(body?.fingerprints).filter(isFingerprint).slice(0, maxThemes);
            const { results } = await db.prepare(`
                SELECT ${themeColumns} FROM sync_themes WHERE user_id = ? AND ${column} IN (SELECT value FROM json_each(?))
                ORDER BY fingerprint
            `).bind(userId, JSON.stringify(filter)).all<ThemeRow>();
            return sharedLoginJson({ themes: results.map(mapTheme) });
        }
        case 'POST /themes/list': {
            const limit = typeof body?.limit === 'number' && Number.isFinite(body.limit)
                ? Math.max(1, Math.min(1000, Math.trunc(body.limit))) : maxThemes;
            const cursor = typeof body?.cursor === 'string' ? body.cursor : '';
            const { results } = await db.prepare(`
                SELECT ${themeColumns} FROM sync_themes WHERE user_id = ? AND fingerprint > ? ORDER BY fingerprint LIMIT ?
            `).bind(userId, cursor, limit).all<ThemeRow>();
            return sharedLoginJson({
                themes: results.map(mapTheme),
                cursor: results.length === limit ? results.at(-1)?.fingerprint : null,
            });
        }
        default:
            return sharedLoginError('not_found', 404);
    }
};
