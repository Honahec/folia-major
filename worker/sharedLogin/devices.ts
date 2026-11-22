// A user's Sync Token enrolls a device. Each device then uses its own revocable session.

export interface SharedLoginStatement {
    bind(...values: (string | number | null)[]): SharedLoginStatement;
    first<T>(column?: keyof T): Promise<T | null>;
    all<T>(column?: keyof T): Promise<{ results: T[] }>;
    run(): Promise<{ meta: { changes: number } }>;
}

export interface SharedLoginDb {
    prepare(sql: string): SharedLoginStatement;
}

export const SHARED_LOGIN_PREFIX = '/api/shared-login';
const DEVICE_COOKIE = '__Host-folia-device';
const SESSION_SECONDS = 90 * 24 * 60 * 60;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export interface SharedLoginDevice {
    id: string;
    userId: string;
    label: string;
}

export const sharedLoginJson = (body: unknown, status = 200, headers?: HeadersInit): Response => {
    const result = new Headers(headers);
    result.set('Cache-Control', 'no-store');
    return Response.json(body, { status, headers: result });
};

export const sharedLoginError = (error: string, status: number): Response => sharedLoginJson({ error }, status);

const hex = (bytes: Uint8Array): string => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');

const hashToken = async (token: string): Promise<string> =>
    hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));

const cookie = (token: string, maxAge: number): string =>
    `${DEVICE_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

// Other routes may forward request headers to providers. Keep this cookie inside the account service.
export const withoutSharedLoginCookie = (request: Request): Request => {
    const cookies = request.headers.get('Cookie');
    if (!cookies?.includes(`${DEVICE_COOKIE}=`)) return request;
    const remaining = cookies.split(';').filter(value => !value.trim().startsWith(`${DEVICE_COOKIE}=`)).join(';');
    const headers = new Headers(request.headers);
    if (remaining.trim()) headers.set('Cookie', remaining);
    else headers.delete('Cookie');
    return new Request(request, { headers });
};

export const isSharedLoginRequestAllowed = (request: Request): boolean => {
    const origin = request.headers.get('Origin');
    const site = request.headers.get('Sec-Fetch-Site');
    return (!origin || origin === new URL(request.url).origin) && (!site || site === 'same-origin' || site === 'none');
};

export const getSharedLoginDevice = async (
    request: Request,
    db: SharedLoginDb,
): Promise<SharedLoginDevice | null> => {
    const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1]
        ?? request.headers.get('Cookie')?.split(';').map(value => value.trim())
            .find(value => value.startsWith(`${DEVICE_COOKIE}=`))?.slice(DEVICE_COOKIE.length + 1);
    if (!token || !TOKEN_PATTERN.test(token)) return null;

    return db.prepare(
        'SELECT id, user_id AS userId, label FROM shared_login_devices WHERE token_hash = ? AND expires_at > ?',
    ).bind(await hashToken(token), Date.now()).first<SharedLoginDevice>();
};

const enroll = async (request: Request, db: SharedLoginDb): Promise<Response> => {
    if (request.method !== 'POST' || request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
        return sharedLoginError('json_required', 415);
    }

    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null || !('token' in body) || !('label' in body)
        || typeof body.token !== 'string' || !TOKEN_PATTERN.test(body.token)
        || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80) {
        return sharedLoginError('invalid_enrollment', 400);
    }

    const browser = request.headers.has('Sec-Fetch-Site') || request.headers.has('Origin');
    const id = crypto.randomUUID();
    const deviceToken = hex(crypto.getRandomValues(new Uint8Array(32)));
    const label = body.label.trim();
    const tokenHash = await hashToken(body.token);
    const result = await db.prepare(`
        INSERT INTO shared_login_devices (id, user_id, token_hash, label, expires_at)
        SELECT ?, id, ?, ?, ? FROM shared_login_users WHERE token_hash = ?
    `).bind(id, await hashToken(deviceToken), label, Date.now() + SESSION_SECONDS * 1000, tokenHash).run();
    if (result.meta.changes !== 1) return sharedLoginError('invalid_token', 401);

    return browser
        ? sharedLoginJson({ id, label }, 201, { 'Set-Cookie': cookie(deviceToken, SESSION_SECONDS) })
        : sharedLoginJson({ id, label, deviceToken }, 201);
};

export const handleSharedLoginDevices = async (
    request: Request,
    db: SharedLoginDb,
    path: string,
    device: SharedLoginDevice | null,
): Promise<Response> => {
    if (path === '/enroll') return enroll(request, db);
    if (!device) return sharedLoginError('device_required', 401);
    if (request.method === 'GET' && path === '/device') {
        return sharedLoginJson({ id: device.id, label: device.label });
    }
    if (request.method === 'GET' && path === '/devices') {
        const { results } = await db.prepare(
            'SELECT id, label FROM shared_login_devices WHERE user_id = ? AND expires_at > ? ORDER BY label, id',
        ).bind(device.userId, Date.now()).all<{ id: string; label: string }>();
        return sharedLoginJson({ devices: results });
    }
    const id = path === '/device' ? device.id : path.match(/^\/devices\/([a-f0-9-]{36})$/)?.[1];
    if (request.method === 'DELETE' && id) {
        await db.prepare('DELETE FROM shared_login_devices WHERE id = ? AND user_id = ?')
            .bind(id, device.userId).run();
        return sharedLoginJson({ ok: true }, 200, id === device.id ? { 'Set-Cookie': cookie('', 0) } : undefined);
    }
    return sharedLoginError('not_found', 404);
};
