import upstreamCrypto from '@neteasecloudmusicapienhanced/api/util/crypto.js';
import { requestXeapi } from './xeapi.ts';

import { formType, parseCookie, postUpstream, readAnswer, UpstreamError, type UpstreamAnswer, type UpstreamRequest } from './protocol.ts';

// Use the package's protocol primitives with Worker fetch and a fixed set of upstream hosts.

const web = 'https://music.163.com';
const desktop = 'https://interfacepc.music.163.com';
const clientLog = 'https://clientlog.music.163.com';
const pcAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const readJson = async (response: Response): Promise<unknown> => response.json();

export const createRequest = (cookie?: string, identity: string = crypto.randomUUID()): UpstreamRequest => {
    const deviceId = identity.replaceAll('-', '').toUpperCase();
    return async (path, data, options = {}) => {
        if (!/^\/api\/[\w/-]+$/.test(path)) throw new Error('Invalid NetEase endpoint');
        const account = parseCookie(options.cookie ?? cookie);
        const headers = new Headers({ 'Content-Type': formType, 'Cache-Control': 'no-store', 'User-Agent': pcAgent });
        const mode = options.crypto || 'eapi';
        let answer: UpstreamAnswer;
        if (mode === 'xeapi') {
            answer = await requestXeapi(path, data, account, deviceId, headers);
        } else {
            const webRequest = mode === 'weapi';
            if (!webRequest && mode !== 'eapi') throw new Error('Unsupported NetEase protocol');
            const origin = webRequest ? web : options.domain === clientLog ? clientLog : desktop;
            const csrf = account.__csrf ?? '';
            const identity = { ...account, deviceId, os: account.os ?? 'pc', appver: '3.1.0.203202', __csrf: csrf };
            headers.set('Cookie', Object.entries(identity).map(([key, value]) => `${key}=${value}`).join('; '));
            if (webRequest) headers.set('Referer', `${web}/`);
            const form = webRequest
                ? upstreamCrypto.weapi({ ...data, csrf_token: csrf })
                : upstreamCrypto.eapi(path, {
                    ...data, e_r: false,
                    header: { ...identity, requestId: String(Date.now()), resolution: '1920x1080' },
                });
            answer = await readAnswer(await postUpstream(`${origin}/${mode}${path.slice(4)}`, new URLSearchParams(form), headers), readJson);
        }

        // Multipart modules use a rejected provider response to decide when to retry.
        const code = Number(answer.body.code);
        if (answer.status !== 200) throw new UpstreamError(answer.status, answer.body);
        if (code >= 300 && code <= 599) throw new UpstreamError(code, answer.body);
        const qrPoll = path === '/api/login/qrcode/client/login';
        if (code < 0 || (code >= 600 && !qrPoll)) throw new UpstreamError(400, answer.body);
        return answer;
    };
};
