import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { SharedLoginDb, SharedLoginStatement } from '../../../worker/sharedLogin/devices';

// Run the real migrations and queries against an in-memory SQLite database.

export const openSharedLoginDb = (...migrations: string[]) => {
    const sqlite = new DatabaseSync(':memory:');
    for (const migration of ['0001_devices', ...migrations]) {
        sqlite.exec(readFileSync(new URL(`../../../migrations/sharedLogin/${migration}.sql`, import.meta.url), 'utf8'));
    }
    const db: SharedLoginDb = {
        prepare(sql) {
            const statement = sqlite.prepare(sql);
            const wrap = (values: (string | number | null)[]): SharedLoginStatement => ({
                bind: (...next) => wrap(next),
                first: async <T>() => statement.get(...values) as T | undefined ?? null,
                all: async <T>() => ({ results: statement.all(...values) as T[] }),
                run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } }),
            });
            return wrap([]);
        },
    };

    return { db, sqlite };
};
