import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Create a Folia account in D1 and show its enrollment token once.

const [database, target, ...extra] = process.argv.slice(2);
if (!database || !/^[\w-]+$/.test(database) || !['--local', '--remote'].includes(target) || extra.length > 0) {
    console.error('Usage: node dev/sharedLogin/createUser.mjs <database-name> --local|--remote');
    process.exit(1);
}

const userId = randomUUID();
const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
const sql = `INSERT INTO shared_login_users (id, token_hash) VALUES ('${userId}', '${hash}')`;
const result = spawnSync('wrangler', ['d1', 'execute', database, target, '--command', sql], {
    stdio: 'inherit',
});
if (result.error || result.status !== 0) {
    console.error('Could not create the Folia account.');
    process.exit(1);
}

console.log(`Folia user ${userId}\nSync Token ${token}`);
