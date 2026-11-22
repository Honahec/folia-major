// Share the request and response primitives used by the NetEase protocols.

export const formType = 'application/x-www-form-urlencoded;charset=UTF-8';

export type UpstreamAnswer = { status: number; body: Record<string, unknown>; cookie: string[] };
export class UpstreamError extends Error {
    readonly status: number;
    readonly body: Record<string, unknown>;

    constructor(status: number, body: Record<string, unknown>) {
        super('NetEase rejected the request');
        this.status = status;
        this.body = body;
    }
}

export type UpstreamOptions = { crypto?: string; domain?: string; cookie?: string | Partial<Record<string, string>> };
export type UpstreamRequest = (path: string, data: Record<string, unknown>, options?: UpstreamOptions) => Promise<UpstreamAnswer>;

export const dictionary = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const parseCookie = (cookie?: string | Partial<Record<string, string>>): Partial<Record<string, string>> => {
    if (typeof cookie !== 'string') return cookie ?? {};
    return Object.fromEntries(cookie.split(';').flatMap(pair => {
        const separator = pair.indexOf('=');
        return separator < 0 ? [] : [[pair.slice(0, separator).trim(), pair.slice(separator + 1)]];
    }));
};

export const postUpstream = async (url: string, body: BodyInit, headers: HeadersInit): Promise<Response> => {
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(8_000),
    });
    if (response.status >= 300 && response.status < 400) throw new Error('NetEase redirected the request');
    return response;
};

export const readAnswer = async (response: Response, decode: (response: Response) => Promise<unknown>): Promise<UpstreamAnswer> => {
    const body = dictionary(await decode(response));
    if (!body) throw new Error('NetEase returned a non-object response');
    return { status: response.status, body, cookie: response.headers.getSetCookie() };
};
