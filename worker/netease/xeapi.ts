import { Buffer } from 'node:buffer';
import upstreamCrypto from '@neteasecloudmusicapienhanced/api/util/crypto.js';
import { dictionary, formType, postUpstream, readAnswer, type UpstreamAnswer } from './protocol.ts';

// Fetch the provider's public key in memory so playback works in an isolate with an empty filesystem.

const androidAgent = 'NeteaseMusic/9.5.61.260802021928(9005061);Dalvik/2.1.0 (Linux; U; Android 12)';
const appver = '9.5.61';
type PublicKey = { sk: string; publicKey: string; version: string | number };

const getPublicKey = async (deviceId: string): Promise<PublicKey> => {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => String(byte % 10)).join('');
    const timestamp = String(Date.now());
    const reply = await postUpstream('https://interface.music.163.com/api/bsr/sk/get', new URLSearchParams({
        appVersion: appver, currentKeyVersion: '', deviceId, nonce, os: 'android', requestType: 'active',
        signature: upstreamCrypto.xeapiSign(timestamp, nonce), t1: '', t2: '', timestamp, uid: '',
    }), { 'Content-Type': formType, 'User-Agent': androidAgent, Cookie: `deviceId=${deviceId}` });
    const body = dictionary(await reply.json());
    const data = dictionary(body?.data);
    if (!reply.ok || body?.code !== 200 || !data || typeof data.encryptedData !== 'string'
        || (typeof data.timestamp !== 'number' && typeof data.timestamp !== 'string')
        || upstreamCrypto.xeapiSign(String(data.timestamp), nonce) !== data.signature) {
        throw new Error('NetEase public key request failed');
    }
    const key = dictionary(upstreamCrypto.xeapiDecryptPublicKey(data.encryptedData));
    if (!key || typeof key.sk !== 'string' || typeof key.publicKey !== 'string'
        || (typeof key.version !== 'string' && typeof key.version !== 'number')) {
        throw new Error('NetEase returned an invalid public key');
    }
    return { sk: key.sk, publicKey: key.publicKey, version: key.version };
};

const decode = async (response: Response): Promise<unknown> => {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (response.headers.get('Content-Type')?.includes('application/json')) {
        try {
            return JSON.parse(bytes.toString());
        } catch {
            // Some encrypted responses are also marked as JSON.
        }
    }
    return upstreamCrypto.xeapiResDecrypt(bytes);
};

export const requestXeapi = async (
    path: string, data: Record<string, unknown>, account: Partial<Record<string, string>>, deviceId: string, headers: Headers,
): Promise<UpstreamAnswer> => {
    const os = 'android';
    const osver = '16';
    const buildver = String(Math.floor(Date.now() / 1000));
    const publicKeyState = await getPublicKey(deviceId);
    const form = upstreamCrypto.xeapi(path, data, { publicKeyState, deviceId, os, appver });
    const cookies = { ...account, deviceId, sDeviceId: deviceId, os, osver, appver, buildver };
    headers.set('Cookie', Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; '));
    headers.set('User-Agent', androidAgent);
    headers.set('X-Client-Enc-State', 'ENCRYPTED');
    headers.set('x-aeapi', 'true');
    headers.set('x-deviceid', deviceId);
    headers.set('x-sdeviceid', deviceId);
    headers.set('x-os', os);
    headers.set('x-osver', osver);
    headers.set('x-appver', appver);
    headers.set('x-buildver', buildver);
    if (account.MUSIC_U) headers.set('x-music-u', account.MUSIC_U);
    return readAnswer(await postUpstream(
        `https://interface3.music.163.com/xeapi${path.slice(4)}`, new URLSearchParams(form), headers,
    ), decode);
};
