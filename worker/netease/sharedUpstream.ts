import { sharedLoginError } from '../sharedLogin/devices.ts';
import { dictionary, type UpstreamAnswer } from './protocol.ts';
import { createRequest } from './transport.ts';
import { neteaseModule } from './upstreamModules.ts';

// Keep the provider session encrypted and send only sanitized answers to clients.

export type NeteaseSharedEnv = { NETEASE_SESSION_SECRET?: string };

export const sharedNeteaseAvailable = (env: NeteaseSharedEnv): boolean =>
    /^[a-f0-9]{64}$/.test(env.NETEASE_SESSION_SECRET ?? '');

export { dictionary } from './protocol.ts';

const credentials = [
    'MUSIC_U', 'MUSIC_R_U', 'MUSIC_A_T', 'MUSIC_R_T', 'MUSIC_A', '__csrf',
] as const;
const credentialFields = new Set(['cookie', 'cookies', 'set-cookie', ...credentials.map(name => name.toLowerCase())]);

export const requestUpstream = async (
    path: string, params = new URLSearchParams(), cookie?: string, identity?: string,
): Promise<UpstreamAnswer | null> => {
    const run = neteaseModule(path);
    if (!run) return null;
    const query = { ...Object.fromEntries(params), cookie: cookie ?? '' };
    try {
        return await run(query, createRequest(cookie, identity));
    } catch (error) {
        // The upstream adapters reject protocol errors so their own retry logic can handle them.
        const rejected = dictionary(error);
        const body = dictionary(rejected?.body);
        if (!body || typeof rejected?.status !== 'number') return null;
        return { status: rejected.status, body, cookie: [] };
    }
};

export const sessionCookie = (lines: string[], previous = ''): string | null => {
    const fields = new Map<string, string>();
    for (const line of [previous, ...lines]) {
        for (const name of credentials) {
            const value = line.match(new RegExp(`(?:^|[;,]\\s*)${name}=([^;,\\s]*)`))?.[1];
            if (value !== undefined && /^[A-Za-z0-9%._~+\-/=]*$/.test(value)) fields.set(name, value);
        }
    }
    if (!fields.get('MUSIC_U')) return null;
    return Array.from(fields).filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join('; ');
};

const encode = (value: string) => new TextEncoder().encode(value);
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

const secretKey = (env: NeteaseSharedEnv) => crypto.subtle.importKey(
    'raw',
    Uint8Array.from((env.NETEASE_SESSION_SECRET ?? '').match(/../g) ?? [], hex => Number.parseInt(hex, 16)),
    'AES-GCM', false, ['encrypt', 'decrypt'],
);

export const sealCookie = async (env: NeteaseSharedEnv, userId: string, cookie: string): Promise<string> => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encode(`netease:${userId}`) }, await secretKey(env), encode(cookie),
    );
    return `${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
};

export const openCookie = async (env: NeteaseSharedEnv, userId: string, sealed: string): Promise<string | null> => {
    try {
        const [iv, data] = sealed.split('.');
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fromBase64(iv), additionalData: encode(`netease:${userId}`) },
            await secretKey(env), fromBase64(data),
        );
        return new TextDecoder().decode(plaintext);
    } catch {
        return null;
    }
};

const stripCredentials = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripCredentials);
    const object = dictionary(value);
    if (!object) return value;
    return Object.fromEntries(Object.entries(object)
        .filter(([name]) => !credentialFields.has(name.toLowerCase()))
        .map(([name, entry]) => [name, stripCredentials(entry)]));
};

export const upstreamResponse = (result: UpstreamAnswer | null, connectionId?: string | null): Response => {
    if (!result) return sharedLoginError('provider_unreachable', 502);
    if (result.status >= 500) return sharedLoginError('provider_unreachable', 502);
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    if (connectionId) headers.set('X-Folia-Connection', connectionId);
    return Response.json(stripCredentials(result.body), { status: result.status, headers });
};
