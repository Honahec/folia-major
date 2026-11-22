import {
    SegmentationRequestError,
    readSegmentationLines,
    segmentLyricLines,
} from '../shared/lyricSegmentationService.mjs';

// worker/segment-lyrics.ts
// Cloudflare Worker adapter for lyric word segmentation. Identical in behaviour to the Vercel
// handler; the only difference is that env arrives as an argument instead of on process.env.

export type SegmentLyricsEnv = {
    AI_PROVIDER?: string;
    GEMINI_API_KEY?: string;
    GEMINI_API_MODEL?: string;
    OPENAI_API_KEY?: string;
    OPENAI_API_URL?: string;
    OPENAI_API_MODEL?: string;
    OPENAI_API_TEMPERATURE?: string;
};

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

export async function handleSegmentLyrics(request: Request, env: SegmentLyricsEnv, privateProfile = false): Promise<Response> {
    if (request.method !== 'POST') {
        return json({ error: 'Method Not Allowed' }, 405);
    }

    try {
        const lines = readSegmentationLines(await request.json());
        const segmented = await segmentLyricLines(lines, env, privateProfile
            ? (url, init) => fetch(url, { ...init, redirect: 'error' })
            : fetch, !privateProfile);
        return json({ lines: segmented }, 200);
    } catch (error) {
        if (privateProfile) return json({ error: 'AI service request failed' }, 502);
        const status = error instanceof SegmentationRequestError ? error.status : 500;
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        console.error('[worker] segment-lyrics failed:', message);
        return json({ error: message }, status);
    }
}
