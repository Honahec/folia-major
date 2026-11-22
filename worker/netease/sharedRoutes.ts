// Limit shared sessions to the routes and parameters used by Folia's player.

const reads = new Map(Object.entries({
    '/user/account': '',
    '/listen/data/total': '',
    '/listen/data/realtime/report': 'type',
    '/listen/data/report': 'endTime type',
    '/listen/data/today/song': '',
    '/listen/data/song/play/rank': 'endTime type',
    '/listen/data/year/report': '',
    '/summary/annual': 'year',
    '/record/recent/song': 'limit',
    '/recent/listen/list': '',
    '/user/detail': 'uid',
    '/user/subcount': '',
    '/user/level': '',
    '/user/follows': 'uid limit offset',
    '/user/followeds': 'uid limit offset',
    '/song/like/check': 'ids',
    '/lyric': 'id',
    '/song/wiki/summary': 'id',
    '/comment/music': 'id before limit offset',
    '/comment/hot': 'id before limit offset type',
    '/toplist/detail': '',
    '/search': 'keywords limit offset type',
    '/user/playlist': 'uid limit offset',
    '/user/record': 'uid type',
    '/user/cloud': 'limit offset',
    '/user/cloud/detail': 'id',
    '/likelist': 'uid',
    '/song/detail': 'ids',
    '/song/copyright/rcmd': 'songid',
    '/song/url/v1': 'id level https',
    '/song/chorus': 'id',
    '/lyric/new': 'id',
    '/cloud/lyric/get': 'uid sid',
    '/playlist/track/all': 'id limit offset',
    '/playlist/detail': 'id',
    '/playlist/detail/dynamic': 'id',
    '/album': 'id',
    '/album/sublist': 'limit offset',
    '/album/detail/dynamic': 'id',
    '/artist/detail': 'id',
    '/artist/desc': 'id',
    '/artist/album': 'id limit offset',
    '/artist/top/song': 'id',
    '/artist/songs': 'id limit offset order',
    '/cloudsearch': 'keywords limit offset type',
    '/personal_fm': '',
    '/personal/fm/mode': 'mode submode',
    '/recommend/songs': 'afresh',
    '/recommend/category/configs': '',
    '/recommend/category/songs': '',
    '/history/recommend/songs': '',
    '/history/recommend/songs/detail': 'date',
    '/personalized': 'limit',
    '/homepage/block/page': 'refresh cursor',
    '/recommend/resource': '',
    '/toplist': '',
    '/top/song': 'type',
    '/album/new': 'limit offset',
    '/top/playlist': 'order limit offset',
    '/simi/song': 'id limit offset',
}));

const numericPathParameter = new Map([
    ['/album', 'id'], ['/artist/album', 'id'], ['/follow', 'id'], ['/summary/annual', 'year'],
    ['/user/detail', 'uid'], ['/user/follows', 'uid'], ['/user/followeds', 'uid'],
    ['/comment/music', 'id'], ['/comment/hot', 'id'],
]);

const writes = new Map(Object.entries({
    '/like': 'id like',
    '/playlist/create': 'name privacy type',
    '/playlist/name/update': 'id name',
    '/playlist/desc/update': 'id desc',
    '/playlist/tags/update': 'id tags',
    '/artist/sub': 'id t',
    '/follow': 'id t',
    '/scrobble': 'id sourceid time',
    '/daily_signin': 'type',
    '/playlist/tracks': 'op pid tracks',
    '/playlist/subscribe': 't id',
    '/album/sub': 't id',
    '/scrobble/v1': 'id time name artist level bitrate total',
    '/recommend/songs/dislike': 'id',
    '/recommend/category/set': 'category tags',
    '/fm_trash': 'id',
}));

export const isSharedNeteaseWrite = (path: string): boolean => writes.has(path);

export const sharedNeteaseQuery = (path: string, incoming: URLSearchParams): URLSearchParams | null => {
    const allowed = reads.get(path) ?? writes.get(path);
    if (allowed === undefined) return null;
    const query = new URLSearchParams();
    for (const key of allowed ? allowed.split(' ') : []) {
        const value = incoming.get(key);
        if (value !== null) query.set(key, value);
    }
    const pathParameter = numericPathParameter.get(path);
    if (pathParameter && !/^\d{1,20}$/.test(query.get(pathParameter) ?? '')) return null;
    if (path === '/comment/hot' && !/^\d{1,2}$/.test(query.get('type') ?? '0')) return null;
    return query;
};
