import {
    getSharedLoginDevice, handleSharedLoginDevices, isSharedLoginRequestAllowed,
    SHARED_LOGIN_PREFIX, sharedLoginError, type SharedLoginDb,
} from './devices.ts';

// Mount the account service only when the deployment has its own D1 binding.

export type SharedLoginEnv = { FOLIA_SHARED_LOGIN_DB?: SharedLoginDb };

export const handleSharedLogin = async (request: Request, env: SharedLoginEnv): Promise<Response> => {
    const db = env.FOLIA_SHARED_LOGIN_DB;
    if (!db) return sharedLoginError('shared_login_unavailable', 503);
    if (!isSharedLoginRequestAllowed(request)) return sharedLoginError('forbidden_origin', 403);

    const path = new URL(request.url).pathname.slice(SHARED_LOGIN_PREFIX.length);
    try {
        const device = path === '/enroll' ? null : await getSharedLoginDevice(request, db);
        return await handleSharedLoginDevices(request, db, path, device);
    } catch {
        return sharedLoginError('shared_login_failed', 500);
    }
};
