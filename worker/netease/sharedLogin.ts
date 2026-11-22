import { sharedLoginError, sharedLoginJson, type SharedLoginDb, type SharedLoginDevice } from '../sharedLogin/devices.ts';
import type { SharedLoginEnv, SharedLoginProvider } from '../sharedLogin/routes.ts';
import { isSharedNeteaseWrite, sharedNeteaseQuery } from './sharedRoutes.ts';
import {
    dictionary, openCookie, requestUpstream, sealCookie, sessionCookie, sharedNeteaseAvailable, upstreamResponse,
    type NeteaseSharedEnv,
} from './sharedUpstream.ts';

// Bind the scan and credential to one Folia user. Account requests can only use the connection they observed.

const HOUR = 60 * 60_000;
const QR_LIFETIME = 3 * 60_000;
const CONNECTION = 'X-Folia-Connection';

type Session = {
    connection_id: string | null;
    sealed_token: string | null;
    qr_id: string | null;
    qr_key: string | null;
    qr_device_id: string | null;
    confirmed_device_id: string | null;
    confirmed_at: number | null;
};

const readSession = (db: SharedLoginDb, userId: string) => db.prepare(`
    SELECT connection_id, sealed_token, qr_id, qr_key, qr_device_id, confirmed_device_id, confirmed_at
    FROM shared_provider_sessions WHERE user_id = ? AND provider = 'netease'
`).bind(userId).first<Session>();

const startQr = async (db: SharedLoginDb, device: SharedLoginDevice) => {
    const attempt = crypto.randomUUID();
    await db.prepare(`
        INSERT INTO shared_provider_sessions (user_id, provider, qr_id, qr_device_id)
        VALUES (?, 'netease', ?, ?)
        ON CONFLICT (user_id, provider) DO UPDATE
        SET qr_id = excluded.qr_id, qr_device_id = excluded.qr_device_id, qr_key = NULL
    `).bind(device.userId, attempt, device.id).run();
    const response = await requestUpstream('/login/qr/key', undefined, undefined, attempt);
    const key = dictionary(response?.body.data)?.unikey;
    if (!response || response.status !== 200 || typeof key !== 'string' || !key || key.length > 4096) {
        return sharedLoginError('provider_qr_unavailable', 502);
    }
    const saved = await db.prepare(`
        UPDATE shared_provider_sessions SET qr_key = ?
        WHERE user_id = ? AND provider = 'netease' AND qr_id = ? AND qr_device_id = ?
    `).bind(key, device.userId, attempt, device.id).run();
    return saved.meta.changes === 1
        ? sharedLoginJson({ code: 200, data: { unikey: attempt } })
        : sharedLoginJson({ code: 800 });
};

const checkQr = async (
    env: NeteaseSharedEnv, db: SharedLoginDb, device: SharedLoginDevice, path: string, attempt: string,
) => {
    const session = await readSession(db, device.userId);
    if (path === '/login/qr/check' && session?.connection_id === attempt && session.sealed_token
        && session.confirmed_device_id === device.id && session.confirmed_at && Date.now() - session.confirmed_at < QR_LIFETIME) {
        return sharedLoginJson({ code: 803 });
    }
    if (!session?.qr_key || session.qr_id !== attempt || session.qr_device_id !== device.id) {
        return sharedLoginJson({ code: 800 });
    }

    const query = new URLSearchParams({ key: session.qr_key });
    const response = await requestUpstream(path, query, undefined, attempt);
    if (path !== '/login/qr/check' || response?.status !== 200 || response.body.code !== 803) return upstreamResponse(response);

    const cookie = sessionCookie(response.cookie);
    if (!cookie) return sharedLoginError('provider_session_missing', 502);
    const sealed = await sealCookie(env, device.userId, cookie);
    const now = Date.now();
    const saved = await db.prepare(`
        UPDATE shared_provider_sessions SET sealed_token = ?, refresh_after = ?, refresh_until = 0,
            connection_id = ?, confirmed_device_id = ?, confirmed_at = ?,
            qr_id = NULL, qr_device_id = NULL, qr_key = NULL
        WHERE user_id = ? AND provider = 'netease' AND qr_id = ? AND qr_device_id = ?
          AND EXISTS (SELECT 1 FROM shared_login_devices WHERE id = ? AND expires_at > ?)
    `).bind(sealed, now + HOUR, attempt, device.id, now, device.userId, attempt, device.id, device.id, now).run();
    return sharedLoginJson({ code: saved.meta.changes === 1 ? 803 : 800 });
};

const unlink = async (db: SharedLoginDb, userId: string, expected: string | null) => {
    if (!expected) return sharedLoginError('connection_changed', 409);
    const result = await db.prepare(`
        DELETE FROM shared_provider_sessions
        WHERE user_id = ? AND provider = 'netease' AND connection_id = ?
    `).bind(userId, expected).run();
    return result.meta.changes === 1 ? sharedLoginJson({ code: 200 }) : sharedLoginError('connection_changed', 409);
};

const handleRequest = async (
    request: Request, env: NeteaseSharedEnv, db: SharedLoginDb, device: SharedLoginDevice, path: string,
): Promise<Response> => {
    if (!sharedNeteaseAvailable(env)) return sharedLoginError('provider_unavailable', 503);
    const expected = request.headers.get(CONNECTION);
    if (path === '/connection' && request.method === 'DELETE') return unlink(db, device.userId, expected);
    if (path === '/connection' && request.method === 'GET') {
        const session = await readSession(db, device.userId);
        return sharedLoginJson({ connectionId: session?.sealed_token ? session.connection_id : null });
    }
    if (request.method !== (isSharedNeteaseWrite(path) ? 'POST' : 'GET')) return sharedLoginError('method_not_allowed', 405);

    const { searchParams } = new URL(request.url);
    if (path === '/login/qr/key') return startQr(db, device);
    if (path === '/login/qr/check' || path === '/login/qr/create') {
        return checkQr(env, db, device, path, searchParams.get('key') ?? '');
    }

    const discovery = path === '/login/status';
    const query = discovery ? new URLSearchParams() : sharedNeteaseQuery(path, searchParams);
    if (!query) return sharedLoginError('not_found', 404);
    const session = await readSession(db, device.userId);
    if (!discovery && (isSharedNeteaseWrite(path) || expected)
        && (!expected || session?.connection_id !== expected || !session.sealed_token)) {
        return sharedLoginError('connection_changed', 409);
    }
    if (discovery && !session?.sealed_token) return sharedLoginJson({ code: 200, data: { profile: null } });
    let cookie: string | undefined;
    if (session?.sealed_token && (discovery || expected)) {
        const opened = await openCookie(env, device.userId, session.sealed_token);
        if (!opened) return sharedLoginError('provider_session_unreadable', 502);
        cookie = opened;
    }
    const result = await requestUpstream(path, query, cookie, cookie ? session?.connection_id ?? undefined : undefined);
    return upstreamResponse(result, discovery ? session?.connection_id : null);
};

const refreshSessions = async (db: SharedLoginDb, env: NeteaseSharedEnv) => {
    if (!sharedNeteaseAvailable(env)) return;
    const now = Date.now();
    const leaseUntil = now + 2 * 60_000;
    // Claim the batch in one query and leave room for the other provider under D1's Free limit.
    const items = await db.prepare(`
        UPDATE shared_provider_sessions SET refresh_until = ?
        WHERE rowid IN (
            SELECT rowid FROM shared_provider_sessions
            WHERE provider = 'netease' AND sealed_token IS NOT NULL AND refresh_after <= ? AND refresh_until <= ?
            ORDER BY refresh_after LIMIT 6
        )
        RETURNING user_id, sealed_token, connection_id
    `).bind(leaseUntil, now, now).all<{ user_id: string; sealed_token: string; connection_id: string | null }>();
    await Promise.all(items.results.map(async ({ user_id: userId, sealed_token: sealed, connection_id: connectionId }) => {
        const current = await openCookie(env, userId, sealed);
        const response = current ? await requestUpstream('/login/refresh', undefined, current, connectionId ?? undefined) : null;
        const code = response?.body.code;
        const rotated = response && code === 200 && current ? sessionCookie(response.cookie, current) : null;
        const expired = code === 301 || code === 401;
        const next = expired ? null : rotated && rotated !== current ? await sealCookie(env, userId, rotated) : sealed;
        const retry = response && response.status < 500 ? 12 * HOUR : HOUR;
        await db.prepare(`
            UPDATE shared_provider_sessions SET sealed_token = ?, refresh_after = ?, refresh_until = 0
            WHERE user_id = ? AND provider = 'netease' AND sealed_token = ? AND refresh_until = ?
        `).bind(next, now + retry, userId, sealed, leaseUntil).run();
    }));
};

export const sharedNeteaseProvider: SharedLoginProvider<SharedLoginEnv & NeteaseSharedEnv> = {
    id: 'netease',
    available: sharedNeteaseAvailable,
    request: handleRequest,
    refresh: refreshSessions,
};

export type { NeteaseSharedEnv } from './sharedUpstream.ts';
