// Describe just the internal exports we use from the pinned NetEase API package.

declare module '@neteasecloudmusicapienhanced/api/module/*.js' {
    import type { UpstreamAnswer, UpstreamRequest } from './protocol.ts';

    const run: (query: Record<string, string>, request: UpstreamRequest) => Promise<UpstreamAnswer>;
    export default run;
}

declare module '@neteasecloudmusicapienhanced/api/util/crypto.js' {
    const upstreamCrypto: {
        weapi(data: Record<string, unknown>): Record<string, string>;
        eapi(path: string, data: Record<string, unknown>): Record<string, string>;
        xeapi(path: string, data: Record<string, unknown>, options: {
            publicKeyState: { sk: string; publicKey: string; version: string | number };
            deviceId: string;
            os: string;
            appver: string;
        }): Record<string, string>;
        xeapiSign(timestamp: string, nonce: string): string;
        xeapiDecryptPublicKey(data: string): unknown;
        xeapiResDecrypt(data: Uint8Array): unknown;
    };
    export default upstreamCrypto;
}

declare module '@neteasecloudmusicapienhanced/api/util/ncbl.js' {
    type Context = { app: { version: string } };
    type Song = { id: number; time: number; name: string; artist: string; bitrate: number; level: string; vip: boolean };
    type Source = { id: string; type: string; name: string };
    const ncbl: {
        parseCookie(cookie: string): Record<string, string>;
        extractContext(cookie: Record<string, string>): Context;
        buildMetaJson(context: Context): string;
        buildCookieStr(context: Context): string;
        buildPlv(context: Context, song: Song, source: Source): Record<string, unknown>;
        buildPld(context: Context, song: Song, source: Source, played: number): Record<string, unknown>;
        buildRecords(records: { time: number; action: string; data: Record<string, unknown> }[]): string;
        encryptNCBL(metadata: string, records: string): Uint8Array;
        buildMultipart(payload: Uint8Array): { boundary: string; fileName: string; multipartBody: Uint8Array };
    };
    export default ncbl;
}

declare module 'qrcode/lib/server.js' {
    const qrCode: { toDataURL(value: string): Promise<string> };
    export default qrCode;
}
