import { handleAccountAi } from '../sync/accountAi.ts';
import { handleAiProfile, type AiProfileEnv } from '../sync/aiProfile.ts';
import { handleUserSync } from '../sync/routes.ts';
import {
    getSharedLoginDevice, handleSharedLoginDevices, isSharedLoginRequestAllowed,
    SHARED_LOGIN_PREFIX, sharedLoginError, sharedLoginJson, type SharedLoginDb, type SharedLoginDevice,
} from './devices.ts';

// Mount the account service only when the deployment has its own D1 binding.

export type SharedLoginEnv = { FOLIA_SHARED_LOGIN_DB?: SharedLoginDb } & AiProfileEnv;

export interface SharedLoginProvider<Env extends SharedLoginEnv> {
    id: string;
    available?(env: Env): boolean;
    request(request: Request, env: Env, db: SharedLoginDb, device: SharedLoginDevice, path: string): Promise<Response>;
    refresh(db: SharedLoginDb, env: Env): Promise<void>;
}

export const createSharedLoginRoutes = <Env extends SharedLoginEnv>(providers: readonly SharedLoginProvider<Env>[]) => ({
    async fetch(request: Request, env: Env): Promise<Response> {
        const db = env.FOLIA_SHARED_LOGIN_DB;
        if (!db) return sharedLoginError('shared_login_unavailable', 503);
        if (!isSharedLoginRequestAllowed(request)) return sharedLoginError('forbidden_origin', 403);

        const path = new URL(request.url).pathname.slice(SHARED_LOGIN_PREFIX.length);
        try {
            const device = path === '/enroll' ? null : await getSharedLoginDevice(request, db);
            const discovery = request.method === 'GET' && path === '/device';
            if (discovery && device) {
                const availableProviders = providers.filter(item => item.available?.(env) ?? true).map(item => item.id);
                return sharedLoginJson({ id: device.id, label: device.label, accountId: device.userId, providers: availableProviders });
            }
            if (device && !discovery && request.headers.get('X-Folia-Device') !== device.id) {
                return sharedLoginError('device_changed', 409);
            }
            if (path === '/ai/settings') {
                return device ? await handleAiProfile(request, db, device, env) : sharedLoginError('device_required', 401);
            }
            if (path === '/ai/theme' || path === '/ai/segment') {
                return device ? await handleAccountAi(request, db, device, env, path) : sharedLoginError('device_required', 401);
            }
            if (path.startsWith('/sync/')) {
                return device ? await handleUserSync(request, db, device.userId, path.slice('/sync'.length))
                    : sharedLoginError('device_required', 401);
            }
            const provider = providers.find(item => path.startsWith(`/${item.id}/`));
            if (provider) {
                if (provider.available && !provider.available(env)) return sharedLoginError('provider_unavailable', 503);
                return device ? await provider.request(request, env, db, device, path.slice(provider.id.length + 1))
                    : sharedLoginError('device_required', 401);
            }
            return await handleSharedLoginDevices(request, db, path, device);
        } catch {
            return sharedLoginError('shared_login_failed', 500);
        }
    },
    async scheduled(env: Env): Promise<void> {
        const db = env.FOLIA_SHARED_LOGIN_DB;
        if (db) await Promise.all(providers.map(provider => provider.refresh(db, env)));
    },
});
