import type { SharedLoginEnv, SharedLoginProvider } from '../sharedLogin/routes.ts';
import { handleQqServerlessRequest, type QqServerlessEnv } from '../qq.ts';
import {
    sharedLoginError, sharedLoginJson, type SharedLoginDb, type SharedLoginDevice,
} from '../sharedLogin/devices.ts';

// Keep the QQ credential in the Worker and attach it to requests from linked devices.

const HOUR = 60 * 60 * 1000;
const REFRESH_LEASE = 2 * 60 * 1000;
const SESSION_PATH = '/login/status';
const QR_ROUTES = new Set(['/login/qr/key', '/login/qr/create', '/login/qr/check', '/login/qr/cancel']);
// Bind credentials only for the provider operations Folia currently uses.
const catalogReads = new Set([
    '/user/detail', '/user/playlist', '/user/albums', '/user/liked-songs', '/user/playlist-detail',
    '/user/guess-you-like', '/user/daily-songs', '/user/personal-fm', '/user/daily-songs/history/dates',
    '/user/daily-songs/history', '/user/listening-rank', '/user/guess-you-like/modes',
    '/user/guess-you-like/tracks', '/user/recommendation-preferences', '/user/subscription-status',
    '/user/vip', '/user/cloud',
    '/recommend/feed', '/recommend/playlists', '/recommend/new-songs', '/recommend/new-albums',
    '/recommend/toplists', '/recommend/toplist', '/recommend/categories', '/recommend/category-playlists',
    '/recommend/radar', '/radio/list', '/radio/tracks', '/song/similar',
    '/getAlbumInfo', '/getSingerAlbum', '/getSingerHotsong', '/search',
]);
const catalogWrites = new Set([
    '/user/blacklist/add', '/user/recommendation-preferences/update', '/user/playlist/tracks',
    '/user/playlist/subscribe', '/user/song/like', '/user/album/subscribe', '/user/playlist/create',
]);
const catalogItem = /^\/(?:getMusicPlay|getSongListDetail)\/[a-zA-Z0-9_-]+$|^\/getSongInfo\/[a-zA-Z0-9_-]+(?:\/\d+)?$/;


type ProviderSession = { sealed_token: string | null; refresh_after: number; qr_id: string | null; qr_key: string | null; qr_device_id: string | null };

const readSession = (db: SharedLoginDb, userId: string) => db.prepare(`
    SELECT sealed_token, refresh_after, qr_id, qr_key, qr_device_id
    FROM shared_provider_sessions WHERE user_id = ? AND provider = 'qq'
`).bind(userId).first<ProviderSession>();

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const jsonBody = async (response: Response) => recordOf(await response.json().catch(() => null));

const readSeal = (value: unknown): string | null =>
    typeof value === 'string' && value.length <= 8192 && /^[a-zA-Z0-9_.-]+$/.test(value) ? value : null;

const providerRequest = (
    env: QqServerlessEnv,
    origin: string,
    path: string,
    query: URLSearchParams,
    method = 'GET',
    payload?: string,
    seal?: string | null,
) => {
    const headers = new Headers();
    if (seal) headers.set('X-QQ-Session', seal);
    if (payload) headers.set('Content-Type', 'application/json');
    return handleQqServerlessRequest(
        new Request(new URL(path, origin), { method, headers, body: payload }),
        path, query.size ? `?${query.toString()}` : '', env,
    );
};

const passResponse = async (response: Response) => {
    const body = await jsonBody(response);
    if (!body) return sharedLoginError('provider_response_invalid', 502);
    const retryAfter = response.headers.get('Retry-After');
    return sharedLoginJson(body, response.status, retryAfter ? { 'Retry-After': retryAfter } : undefined);
};

const handleQr = async (
    env: QqServerlessEnv, db: SharedLoginDb, device: SharedLoginDevice, url: URL, path: string,
): Promise<Response> => {
    const { userId, id: deviceId } = device;
    if (path === '/login/qr/key') {
        const channel = url.searchParams.get('channel') ?? 'wechat';
        if (channel !== 'wechat' && channel !== 'qq') return sharedLoginError('unsupported_channel', 400);
        const qrId = crypto.randomUUID();
        await db.prepare(`
            INSERT INTO shared_provider_sessions (user_id, provider, qr_id, qr_device_id)
            VALUES (?, 'qq', ?, ?)
            ON CONFLICT (user_id, provider) DO UPDATE
            SET qr_id = excluded.qr_id, qr_device_id = excluded.qr_device_id, qr_key = NULL
        `).bind(userId, qrId, deviceId).run();
        const upstream = await providerRequest(env, url.origin, path, new URLSearchParams({ channel }));
        const body = await jsonBody(upstream);
        const key = recordOf(body?.data)?.unikey;
        if (!upstream.ok || typeof key !== 'string' || !key || key.length > 500_000) {
            return sharedLoginError('provider_qr_unavailable', upstream.ok ? 502 : upstream.status);
        }
        const saved = await db.prepare(`
            UPDATE shared_provider_sessions SET qr_key = ?
            WHERE user_id = ? AND provider = 'qq' AND qr_id = ? AND qr_device_id = ?
        `).bind(key, userId, qrId, deviceId).run();
        return saved.meta.changes === 1
            ? sharedLoginJson({ code: 200, data: { unikey: qrId } })
            : sharedLoginJson({ code: 800, message: 'A newer sign-in replaced this QR code' }, 409);
    }

    const session = await readSession(db, userId);
    const qrId = url.searchParams.get('key');
    if (!qrId || session?.qr_id !== qrId || session.qr_device_id !== deviceId || !session.qr_key) {
        return sharedLoginJson({ code: path === '/login/qr/cancel' ? 200 : 800 });
    }
    if (path === '/login/qr/cancel') {
        await db.prepare(`
            UPDATE shared_provider_sessions SET qr_id = NULL, qr_device_id = NULL, qr_key = NULL
            WHERE user_id = ? AND provider = 'qq' AND qr_id = ?
        `).bind(userId, qrId).run();
        return sharedLoginJson({ code: 200 });
    }

    const upstream = await providerRequest(env, url.origin, path, new URLSearchParams({ key: session.qr_key }));
    if (path === '/login/qr/create') return passResponse(upstream);
    const body = await jsonBody(upstream);
    if (!body) return sharedLoginError('provider_response_invalid', 502);
    if (body.code !== 803) {
        return sharedLoginJson({
            code: body.code, message: body.message, stage: body.stage, upstreamCode: body.upstreamCode,
            retryAfterMs: body.retryAfterMs, failureHint: body.failureHint,
        }, upstream.status);
    }

    const token = typeof body.cookie === 'string' && body.cookie.startsWith('qqmusic_session=')
        ? readSeal(body.cookie.slice('qqmusic_session='.length))
        : null;
    if (!token) return sharedLoginError('provider_session_missing', 502);
    const saved = await db.prepare(`
        UPDATE shared_provider_sessions SET sealed_token = ?, refresh_after = ?, refresh_until = 0,
            qr_id = NULL, qr_device_id = NULL, qr_key = NULL
        WHERE user_id = ? AND provider = 'qq' AND qr_id = ? AND qr_device_id = ?
            AND EXISTS (SELECT 1 FROM shared_login_devices WHERE id = ? AND expires_at > ?)
    `).bind(token, Date.now() + HOUR, userId, qrId, deviceId, deviceId, Date.now()).run();
    return sharedLoginJson({ code: saved.meta.changes === 1 ? 803 : 800 });
};

const handleSharedQq = async (
    request: Request, env: QqServerlessEnv, db: SharedLoginDb, device: SharedLoginDevice, path: string,
): Promise<Response> => {
    if (!env.QQ_SESSION_SECRET) return sharedLoginError('provider_unavailable', 503);
    const url = new URL(request.url);
    if (request.method === 'GET' && QR_ROUTES.has(path)) return handleQr(env, db, device, url, path);
    if (request.method === 'DELETE' && path === '/connection') {
        await db.prepare("DELETE FROM shared_provider_sessions WHERE user_id = ? AND provider = 'qq'").bind(device.userId).run();
        return sharedLoginJson({ ok: true });
    }

    const query = url.searchParams;
    query.delete('cookie');
    if (request.method === 'GET' && path === '/login/channels') {
        return sharedLoginJson({ code: 200, data: { channels: ['wechat', 'qq'] } });
    }
    const canRead = path === SESSION_PATH || catalogReads.has(path) || catalogItem.test(path);
    const canWrite = catalogWrites.has(path);
    if (!canRead && !canWrite) return sharedLoginError('not_found', 404);
    if (request.method !== (canWrite ? 'POST' : 'GET')) return sharedLoginError('method_not_allowed', 405);

    const session = await readSession(db, device.userId);
    if (path === SESSION_PATH && !session?.sealed_token) return sharedLoginError('provider_sign_in_required', 401);
    const payload = request.method === 'POST' ? await request.text() : undefined;
    if (payload && payload.length > 64_000) return sharedLoginError('payload_too_large', 413);
    const response = await providerRequest(env, url.origin, path, query, request.method, payload, session?.sealed_token);
    return passResponse(response);
};

const refreshSharedQqSessions = async (db: SharedLoginDb, env: QqServerlessEnv): Promise<void> => {
    if (!env.QQ_SESSION_SECRET) return;
    const now = Date.now();
    const due = await db.prepare(`
        SELECT user_id, sealed_token FROM shared_provider_sessions
        WHERE provider = 'qq' AND sealed_token IS NOT NULL AND refresh_after <= ? AND refresh_until <= ?
        ORDER BY refresh_after LIMIT 20
    `).bind(now, now).all<{ user_id: string; sealed_token: string }>();
    await Promise.all(due.results.map(async ({ user_id: userId, sealed_token: token }) => {
        const lease = await db.prepare(`
            UPDATE shared_provider_sessions SET refresh_until = ?
            WHERE user_id = ? AND provider = 'qq' AND sealed_token = ? AND refresh_until <= ? AND refresh_after <= ?
        `).bind(now + REFRESH_LEASE, userId, token, now, now).run();
        if (lease.meta.changes !== 1) return;
        try {
            const response = await providerRequest(env, 'https://qq.internal', '/login/refresh', new URLSearchParams(), 'POST', '{}', token);
            const data = recordOf((await jsonBody(response))?.data);
            const replacement = data?.rotated === true ? readSeal(data.token) : null;
            const expired = response.status === 401;
            await db.prepare(`
                UPDATE shared_provider_sessions SET sealed_token = ?, refresh_after = ?, refresh_until = 0
                WHERE user_id = ? AND provider = 'qq' AND sealed_token = ? AND refresh_until = ?
            `).bind(expired ? null : replacement ?? token, now + HOUR, userId, token, now + REFRESH_LEASE).run();
        } catch {
            // If the upstream is unreachable, the lease lets a later run pick the session up again.
        }
    }));
};

export const sharedQqProvider: SharedLoginProvider<SharedLoginEnv & QqServerlessEnv> = {
    id: 'qq',
    request: handleSharedQq,
    refresh: refreshSharedQqSessions,
};
