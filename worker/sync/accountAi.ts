import { AI_PROVIDER_PRESETS, resolveAiConnection } from '../../shared/ai/providerRegistry.mjs';
import { handleGenerateTheme } from '../generate-theme.ts';
import { handleGenerateOpenAITheme } from '../generate-theme_openai.ts';
import { handleSegmentLyrics } from '../segment-lyrics.ts';
import { sharedLoginJson, type SharedLoginDb, type SharedLoginDevice } from '../sharedLogin/devices.ts';
import { readAiProfile, type AiProfileEnv } from './aiProfile.ts';

// Run Web AI operations on the Worker without returning the account profile to the browser.

const allowedOrigins = new Set(AI_PROVIDER_PRESETS.flatMap(preset =>
    preset.endpoints.flatMap(endpoint => URL.canParse(endpoint.baseUrl) ? [new URL(endpoint.baseUrl).origin] : [])));

const acceptsWorkerEndpoint = (value: string) => {
    if (!value.trim()) return true;
    try {
        const url = new URL(value);
        return allowedOrigins.has(url.origin) && url.protocol === 'https:' && !url.username && !url.password
            && !url.search && !url.hash;
    } catch {
        return false;
    }
};

export const handleAccountAi = async (
    request: Request, db: SharedLoginDb, device: SharedLoginDevice, env: AiProfileEnv, path: string,
) => {
    if (request.method !== 'POST') return sharedLoginJson({ error: 'Method Not Allowed' }, 405);
    const record = await readAiProfile(db, device.userId, env);
    if (!record) return sharedLoginJson({ error: 'ai_profile_missing' }, 404);
    const { profile } = record;
    const openAI = profile.AI_PROVIDER === 'openai';
    if (openAI && (!acceptsWorkerEndpoint(profile.OPENAI_API_URL) || resolveAiConnection(profile).protocol !== 'openai')) {
        return sharedLoginJson({ error: 'This AI endpoint is available in the desktop app.' }, 422);
    }
    const currentOrigin = openAI ? new URL(profile.OPENAI_API_URL || 'https://api.openai.com').origin : '';
    if (!(openAI ? profile.OPENAI_API_KEY && profile.OPENAI_API_KEY_ENDPOINT === currentOrigin : profile.GEMINI_API_KEY)) {
        return sharedLoginJson({ error: 'Server configuration error' }, 503);
    }
    if (path === '/ai/segment') {
        return handleSegmentLyrics(request, {
            ...profile, ...(openAI ? { GEMINI_API_KEY: '' } : { OPENAI_API_KEY: '' }),
        }, true);
    }
    return openAI ? handleGenerateOpenAITheme(request, profile, true) : handleGenerateTheme(request, profile, true);
};
