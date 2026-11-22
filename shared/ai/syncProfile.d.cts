// The shared AI settings and credential record.

export interface AiSyncProfile {
    AI_PROVIDER: 'gemini' | 'openai';
    AI_PROVIDER_PRESET: string;
    GEMINI_API_MODEL: string;
    OPENAI_API_URL: string;
    OPENAI_API_KEY_ENDPOINT: string;
    OPENAI_API_MODEL: string;
    OPENAI_API_TEMPERATURE: string;
    OPENAI_API_STREAM: boolean;
    GEMINI_API_KEY: string;
    OPENAI_API_KEY: string;
}
export const AI_PROFILE_FIELDS: readonly (keyof AiSyncProfile)[];
export const KEY_FIELDS: readonly ('GEMINI_API_KEY' | 'OPENAI_API_KEY')[];
export const parseAiSyncProfile: (value: unknown) => AiSyncProfile | null;
