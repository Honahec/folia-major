import ncbl from '@neteasecloudmusicapienhanced/api/util/ncbl.js';
import { dictionary, postUpstream, type UpstreamAnswer } from './protocol.ts';

// Send the same two listening records as the desktop backend through Worker fetch.

export const reportListening = async (query: Record<string, string>): Promise<UpstreamAnswer> => {
    const id = Number(query.id);
    const time = Number(query.time);
    if (!id || !Number.isFinite(time) || time <= 0) return { status: 400, body: { code: 400 }, cookie: [] };
    const cookie = query.cookie;
    const account = ncbl.parseCookie(cookie);
    if (!account.MUSIC_U) return { status: 401, body: { code: 401 }, cookie: [] };
    const context = ncbl.extractContext({ ...account, os: 'pc' });
    const total = Number(query.total) || time;
    const song = {
        id, time: total, name: query.name || '', artist: query.artist || '',
        bitrate: Number(query.bitrate) || 320, level: query.level || 'exhigh', vip: false,
    };
    const source = { id: String(id), type: 'track', name: 'list' };
    const metadata = ncbl.buildMetaJson(context);
    const timestamp = Math.floor(Date.now() / 1000);
    const records = [
        { time: timestamp, action: '_plv', data: ncbl.buildPlv(context, song, source) },
        { time: timestamp, action: '_pld', data: ncbl.buildPld(context, song, source, Math.min(time, total)) },
    ];
    for (const record of records) {
        const payload = ncbl.encryptNCBL(metadata, ncbl.buildRecords([record]));
        const { boundary, fileName, multipartBody } = ncbl.buildMultipart(payload);
        const response = await postUpstream('https://clientlog3.music.163.com/api/clientlog/encrypt/upload?multiupload=true',
            new Uint8Array(multipartBody), {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                Referer: 'https://music.163.com/di',
                'User-Agent': `Mozilla/5.0 NeteaseMusicDesktop/${context.app.version}`,
                Cookie: ncbl.buildCookieStr(context),
            });
        const body = dictionary(await response.json());
        const files = dictionary(body?.data)?.successfiles;
        if (!response.ok || body?.code !== 200 || !Array.isArray(files) || !files.includes(fileName)) {
            return { status: 502, body: { code: 502 }, cookie: [] };
        }
    }
    return { status: 200, body: { code: 200 }, cookie: [] };
};
