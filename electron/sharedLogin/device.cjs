const { readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { encryptionAvailable } = require('../osEncryption.cjs');

// Keep the Worker session in the main process, bound to the origin it came from.

const PREFIX = '/api/shared-login';
const TOKEN = /^[a-f0-9]{64}$/;

const readOrigin = value => {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
        throw new Error('Shared login requires an HTTPS server origin');
    }
    return url.origin;
};

const createSharedLoginDevice = ({ userData, safeStorage, fetch }) => {
    const filename = () => join(userData(), 'sharedLoginDevice.bin');
    const canEncrypt = () => encryptionAvailable(safeStorage, process.platform);
    let current;

    const load = () => {
        if (current !== undefined) return current;
        if (!canEncrypt()) return null;
        try {
            const entry = JSON.parse(safeStorage.decryptString(readFileSync(filename())));
            if (typeof entry.token !== 'string' || !TOKEN.test(entry.token)) return null;
            current = { origin: readOrigin(entry.origin), token: entry.token };
            return current;
        } catch {
            return null;
        }
    };

    const save = entry => {
        if (canEncrypt()) {
            const path = filename();
            const pending = `${path}.part`;
            if (entry) {
                writeFileSync(pending, safeStorage.encryptString(JSON.stringify(entry)), { mode: 0o600 });
                renameSync(pending, path);
            } else {
                rmSync(path, { force: true });
            }
        }
        current = entry;
    };

    const send = async (origin, path, method, body, token, expectedDevice, connectionId) => {
        const url = new URL(`${PREFIX}${path}`, origin);
        if (!url.pathname.startsWith(`${PREFIX}/`) || url.origin !== origin) {
            throw new Error('Invalid shared login route');
        }
        const headers = new Headers({ Accept: 'application/json' });
        if (connectionId) headers.set('X-Folia-Connection', connectionId);
        if (expectedDevice) headers.set('X-Folia-Device', expectedDevice);
        if (token) headers.set('Authorization', `Bearer ${token}`);
        if (body !== undefined) headers.set('Content-Type', 'application/json');
        const timeout = path === '/device' && method === 'GET' ? 5_000 : 75_000;
        const response = await fetch(url.toString(), {
            method, headers, body, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeout),
        });
        return { status: response.status, body: await response.json().catch(() => null), connectionId: response.headers.get('X-Folia-Connection') };
    };

    const enroll = async (url, token, label) => {
        const origin = readOrigin(url);
        const result = await send(origin, '/enroll', 'POST', JSON.stringify({ token, label }));
        if (result.status !== 201) return { status: result.status, body: null };
        const { id, label: deviceLabel, deviceToken } = result.body ?? {};
        if (typeof id !== 'string' || typeof deviceLabel !== 'string' || typeof deviceToken !== 'string' || !TOKEN.test(deviceToken)) {
            throw new Error('The Worker did not return a device session');
        }
        save({ origin, token: deviceToken });
        return { status: 201, body: { id, label: deviceLabel } };
    };

    return {
        origin: () => load()?.origin ?? null,
        enroll,
        async request(path, method, body, expectedDevice, connectionId) {
            const syncWrite = typeof path === 'string' && (path === '/sync/settings' || path === '/sync/themes/put');
            const maxBodyLength = syncWrite ? 1_500_000 : 64_000;
            const allowsBody = method === 'POST' || (method === 'PUT' && path === '/sync/settings');
            if (typeof path !== 'string' || !/^\/(?:device(?:s(?:\/[a-f0-9-]{36})?)?|[a-z][a-z0-9-]*\/[a-zA-Z0-9/_-]+)(?:\?[^#]*)?$/.test(path)
                || (!['GET', 'POST', 'DELETE'].includes(method) && !allowsBody)
                || (connectionId !== undefined && (typeof connectionId !== 'string' || !/^[a-f0-9-]{36}$/.test(connectionId)))
                || (expectedDevice !== undefined && (typeof expectedDevice !== 'string' || !/^[a-f0-9-]{36}$/.test(expectedDevice)))
                || (body !== undefined && (!allowsBody || typeof body !== 'string' || Buffer.byteLength(body) > maxBodyLength))) {
                throw new Error('Invalid shared login request');
            }
            const entry = load();
            if (!entry) return { status: 401, body: { error: 'device_required' } };
            const result = await send(entry.origin, path, method, body, entry.token, expectedDevice, connectionId);
            if (entry === current && result.status === 401 && result.body?.error === 'device_required') save(null);
            if (entry === current && path === '/device' && method === 'DELETE' && result.status === 200) save(null);
            return result;
        },
    };
};

module.exports = { createSharedLoginDevice };
