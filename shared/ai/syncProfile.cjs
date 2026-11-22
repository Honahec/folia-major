// Shared validation for the desktop and Worker AI profile.

const TEXT_FIELDS = Object.freeze({
    AI_PROVIDER_PRESET: 128,
    GEMINI_API_MODEL: 256,
    OPENAI_API_URL: 2048,
    OPENAI_API_KEY_ENDPOINT: 2048,
    OPENAI_API_MODEL: 256,
    OPENAI_API_TEMPERATURE: 32,
});
const KEY_FIELDS = Object.freeze(['GEMINI_API_KEY', 'OPENAI_API_KEY']);
const BOOLEAN_FIELDS = Object.freeze(['OPENAI_API_STREAM']);
const AI_PROFILE_FIELDS = Object.freeze(['AI_PROVIDER', ...Object.keys(TEXT_FIELDS), ...BOOLEAN_FIELDS, ...KEY_FIELDS]);

const parseAiSyncProfile = value => {
    if (!value || typeof value !== 'object' || !['gemini', 'openai'].includes(value.AI_PROVIDER)) return null;
    for (const [field, maxLength] of Object.entries(TEXT_FIELDS)) {
        if (typeof value[field] !== 'string' || value[field].length > maxLength) return null;
    }
    for (const field of BOOLEAN_FIELDS) {
        if (typeof value[field] !== 'boolean') return null;
    }
    for (const field of KEY_FIELDS) {
        if (typeof value[field] !== 'string' || value[field].length > 4096) return null;
    }
    return Object.fromEntries(AI_PROFILE_FIELDS.map(field => [field, value[field]]));
};

module.exports = { AI_PROFILE_FIELDS, KEY_FIELDS, parseAiSyncProfile };
