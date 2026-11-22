const { AI_PROFILE_FIELDS, KEY_FIELDS, parseAiSyncProfile } = require('../../shared/ai/syncProfile.cjs');

// Sync credentials through the main process and leave only account metadata in the settings store.

const OPENAI_BINDING = 'OPENAI_API_KEY_ENDPOINT';
const STATE_KEY = 'AI_SYNC_STATE';
const createAiProfileSync = ({ store, credentials, device }) => {
    let running = false;
    let generation = 0;
    const state = () => store.get(STATE_KEY) ?? {};
    const readProfile = () => Object.fromEntries(AI_PROFILE_FIELDS.map(key => {
        if (KEY_FIELDS.includes(key)) return [key, credentials.readForSync(key)];
        const value = store.get(key);
        if (key === 'AI_PROVIDER') return [key, value === 'openai' ? 'openai' : 'gemini'];
        if (key === 'OPENAI_API_STREAM') return [key, value === true];
        return [key, typeof value === 'string' ? value : ''];
    }));
    const writeProfile = profile => {
        for (const key of AI_PROFILE_FIELDS) {
            if (key !== OPENAI_BINDING && !KEY_FIELDS.includes(key)) store.set(key, profile[key]);
        }
        credentials.set('GEMINI_API_KEY', profile.GEMINI_API_KEY);
        credentials.set('OPENAI_API_KEY', profile.OPENAI_API_KEY, profile.OPENAI_API_KEY_ENDPOINT);
    };

    const markChangedFields = keys => {
        if (!keys.length) return;
        generation++;
        const current = state();
        store.set(STATE_KEY, { ...current, pending: [...new Set([...(current.pending ?? []), ...keys])] });
    };

    const markChanged = key => {
        if (!AI_PROFILE_FIELDS.includes(key)) return;
        markChangedFields(key === 'OPENAI_API_KEY' ? [key, OPENAI_BINDING] : [key]);
    };

    const saveLocal = (draft) => {
        const normalized = parseAiSyncProfile({ ...draft, [OPENAI_BINDING]: '' });
        if (!normalized) return false;
        const previous = readProfile();
        for (const key of AI_PROFILE_FIELDS) {
            if (key !== OPENAI_BINDING && !KEY_FIELDS.includes(key) && normalized[key] !== previous[key]) {
                store.set(key, normalized[key]);
            }
        }
        for (const key of KEY_FIELDS) {
            if (normalized[key].trim()) credentials.set(key, normalized[key]);
        }
        const next = readProfile();
        markChangedFields(AI_PROFILE_FIELDS.filter(key => next[key] !== previous[key]));
        return true;
    };

    const sync = async (origin, id) => {
        if (running) return { status: 'busy' };
        running = true;
        try {
            const client = await device.aiProfileClient(origin, id);
            if (!client) return { status: 'device_changed' };
            const scope = JSON.stringify([origin, client.accountId]);
            let saved = state();
            if (!saved.scope) {
                saved = { ...saved, scope, revision: 0 };
                store.set(STATE_KEY, saved);
            }
            const started = generation;
            const response = await client.request('GET');
            if (!response || !client.isCurrent()) return { status: 'device_changed' };
            if (response.status === 503 || response.status === 404) return { status: 'unavailable' };
            if (response.status !== 200) return { status: 'failed' };
            if (started !== generation) return { status: 'busy' };
            const remoteRevision = response.body?.revision ?? 0;
            if (!Number.isSafeInteger(remoteRevision) || remoteRevision < 0) return { status: 'failed' };
            const remote = response.body ? parseAiSyncProfile(response.body.profile) : null;
            if (response.body && (!remote || remoteRevision === 0)) return { status: 'failed' };

            const sameAccount = saved.scope === scope;
            const pending = sameAccount ? saved.pending ?? [] : [];
            if (!sameAccount || (remote && !pending.length && remoteRevision !== saved.revision)) {
                const replacement = remote ?? Object.fromEntries(AI_PROFILE_FIELDS.map(key =>
                    [key, key === 'AI_PROVIDER' ? 'gemini' : key === 'OPENAI_API_STREAM' ? false : '']));
                writeProfile(replacement);
                store.set(STATE_KEY, { scope, revision: remoteRevision, pending: [] });
                return { status: 'applied' };
            }
            if (remote && !pending.length) return { status: 'unchanged' };

            const local = readProfile();
            const profile = parseAiSyncProfile(remote
                ? { ...remote, ...Object.fromEntries(pending.map(key => [key, local[key]])) }
                : local);
            if (!profile || !remote && !pending.length && !KEY_FIELDS.some(key => profile[key])) {
                return { status: 'unchanged' };
            }
            const result = await client.request('POST', JSON.stringify({ revision: remoteRevision, profile }));
            if (!result || !client.isCurrent()) return { status: 'device_changed' };
            if (result.status === 409) return { status: 'busy' };
            if (result.status !== 200 || result.body?.revision !== remoteRevision + 1) return { status: 'failed' };
            if (started !== generation) return { status: 'busy' };
            const applied = remote && JSON.stringify(profile) !== JSON.stringify(local);
            if (applied) writeProfile(profile);
            store.set(STATE_KEY, { scope, revision: result.body.revision, pending: [] });
            return { status: applied ? 'applied' : 'uploaded' };
        } catch {
            return { status: 'failed' };
        } finally {
            running = false;
        }
    };

    return { markChanged, saveLocal, sync };
};

module.exports = { createAiProfileSync, STATE_KEY };
