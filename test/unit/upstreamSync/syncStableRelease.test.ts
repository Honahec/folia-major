import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Exercise the actual sync script with local Git repositories and a stub for GitHub.

const scripts = fileURLToPath(new URL('../../../dev/upstreamSync/', import.meta.url));
const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

const fixture = (conflict = false) => {
    const dir = mkdtempSync(join(tmpdir(), 'folia-upstream-sync-'));
    scratch.push(dir);
    const repo = join(dir, 'repo');
    const upstream = join(dir, 'upstream.git');
    const fork = join(dir, 'fork.git');
    const bin = join(dir, 'bin');
    const log = join(dir, 'gh.log');
    const summary = join(dir, 'summary.md');
    mkdirSync(repo);
    mkdirSync(bin);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main');
    git('init', '--bare', upstream);
    git('init', '--bare', fork);
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.test');

    const write = (file: string, value: string) => writeFileSync(join(repo, file), value);
    const metadata = (version: string, owner: string, dependency: string) => {
        write('package.json', JSON.stringify({ version, build: { publish: [{ owner }] }, dependencies: { example: dependency } }, null, 2) + '\n');
        write('package-lock.json', JSON.stringify({ version, packages: { '': { version, dependencies: { example: dependency } } } }, null, 2) + '\n');
        write('realeco-release', version + '\n');
    };
    mkdirSync(join(repo, 'electron'));
    mkdirSync(join(repo, '.github'));
    mkdirSync(join(repo, 'deploy/docker'), { recursive: true });
    mkdirSync(join(repo, 'sync-server'));
    mkdirSync(join(repo, 'dev/upstreamSync'), { recursive: true });
    write('dev/upstreamSync/mergeReleaseMetadata.mjs', readFileSync(join(scripts, 'mergeReleaseMetadata.mjs'), 'utf8'));
    write('electron/main.cjs', "const FOLIA_RELEASES_URL = 'upstream';\nconst FOLIA_GITHUB_REPOSITORY = {\n  owner: 'upstream',\n};\n");
    write('.github/protected.yml', 'shared\n');
    write('wrangler.jsonc', 'upstream config\n');
    write('deploy/docker/VERSION', '1.2.9\n');
    write('sync-server/package.json', '{"version":"1.2.9","name":"sync-server"}\n');
    write('sync-server/package-lock.json', '{"version":"1.2.9","packages":{"":{"version":"1.2.9"}}}\n');
    write('song.txt', 'shared\n');
    metadata('1.2.9', 'upstream', '1');
    git('add', '.');
    git('commit', '-m', 'Initial');
    const common = git('rev-parse', 'HEAD');
    git('push', upstream, 'HEAD:refs/tags/v1.2.9');

    git('switch', '-c', 'upstream');
    metadata('1.2.10', 'changed-upstream', '2');
    write('.github/protected.yml', 'upstream config\n');
    write('.github/upstream-only.yml', 'upstream workflow\n');
    write('deploy/docker/VERSION', '1.2.10\n');
    write('sync-server/package.json', '{"version":"1.2.10","name":"sync-server"}\n');
    write('sync-server/package-lock.json', '{"version":"1.2.10","packages":{"":{"version":"1.2.10"}}}\n');
    write('upstream.txt', 'new upstream code\n');
    if (conflict) write('song.txt', 'upstream edit\n');
    git('add', '.');
    git('commit', '-m', 'Upstream stable release');
    const upstreamSha = git('rev-parse', 'HEAD');
    git('tag', '-a', 'v1.2.10', '-m', 'Stable');
    git('push', upstream, 'refs/tags/v1.2.10');

    git('switch', 'main');
    metadata('1.2.9-fork.3', 'fork', '1');
    write('electron/main.cjs', "const FOLIA_RELEASES_URL = 'fork';\nconst FOLIA_GITHUB_REPOSITORY = {\n  owner: 'fork',\n};\n");
    write('.github/protected.yml', 'fork workflow\n');
    write('wrangler.jsonc', 'fork config\n');
    if (conflict) write('song.txt', 'fork edit\n');
    git('add', '.');
    git('commit', '-m', 'Fork changes');
    git('remote', 'add', 'origin', fork);
    git('push', 'origin', 'main');
    git('config', '--unset', 'user.name');
    git('config', '--unset', 'user.email');

    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
    *"/releases?"*) printf '%s\\n' v1.2.10 v1.2.9 limo v2.0.0-beta ;;
    *"/pulls "*) if [ -f "$SYNC_TEST_LOG" ]; then cat "$SYNC_TEST_LOG"; fi ;;
    "pr create "*) printf '%s\\n' https://example.test/pr/1 | tee "$SYNC_TEST_LOG" ;;
    *) exit 2 ;;
esac
`, { mode: 0o755 });
    const run = () => spawnSync('bash', [join(scripts, 'syncStableRelease.sh')], {
        cwd: repo, encoding: 'utf8',
        env: {
            ...process.env, PATH: bin + ':' + process.env.PATH,
            GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
            GITHUB_REPOSITORY: 'fork/folia', GITHUB_STEP_SUMMARY: summary,
            UPSTREAM_REPOSITORY: 'upstream/folia', UPSTREAM_GIT_URL: upstream, SYNC_TEST_LOG: log,
        },
    });
    return { git, run, summary, common, upstreamSha };
};

describe.skipIf(process.platform === 'win32')('scheduled upstream sync', () => {
    it('keeps the fork workflow and version, merges upstream changes and opens one PR', () => {
        const { git, run, summary, upstreamSha } = fixture();
        const base = git('rev-parse', 'main');
        const result = run();
        expect(result.status, result.stderr).toBe(0);
        const branch = 'refs/heads/sync/upstream-v1.2.10';
        expect(git('rev-parse', branch + '^1')).toBe(base);
        expect(git('rev-parse', branch + '^2')).toBe(upstreamSha);
        expect(git('show', branch + ':realeco-release')).toBe('1.2.9-fork.3');
        expect(git('show', branch + ':upstream.txt')).toBe('new upstream code');
        expect(git('diff', '--name-only', base, branch, '--', '.github', 'wrangler.jsonc', 'electron/main.cjs', 'deploy/docker/VERSION')).toBe('');
        expect(JSON.parse(git('show', branch + ':sync-server/package.json'))).toMatchObject({ version: '1.2.9' });
        expect(JSON.parse(git('show', branch + ':sync-server/package-lock.json'))).toMatchObject({ version: '1.2.9', packages: { '': { version: '1.2.9' } } });
        expect(JSON.parse(git('show', branch + ':package.json'))).toMatchObject({
            version: '1.2.9-fork.3', build: { publish: [{ owner: 'fork' }] }, dependencies: { example: '2' },
        });
        expect(JSON.parse(git('show', branch + ':package-lock.json'))).toMatchObject({
            version: '1.2.9-fork.3', packages: { '': { version: '1.2.9-fork.3', dependencies: { example: '2' } } },
        });
        expect(git('ls-remote', '--tags', 'origin')).toBe('');
        expect(readFileSync(summary, 'utf8')).toContain('Opened the integration pull request');
        git('switch', 'main');
        const repeat = run();
        expect(repeat.status, repeat.stderr).toBe(0);
        expect(readFileSync(summary, 'utf8')).toContain('already exists');
        expect(git('rev-parse', 'main')).toBe(base);
    });

    it('reports unresolved conflicts without pushing a branch', () => {
        const { git, run, summary } = fixture(true);
        const result = run();
        expect(result.status, result.stderr).toBe(1);
        expect(readFileSync(summary, 'utf8')).toMatch(/Merge conflicts.*\nsong\.txt\n/s);
        expect(git('ls-remote', '--heads', 'origin', 'sync/*')).toBe('');
        expect(git('status', '--porcelain')).toBe('');
    });

    it('skips when the stable tag is in the ancestry of main', () => {
        const { git, run, summary, upstreamSha } = fixture();
        git('merge', '--no-ff', '-s', 'ours', '--no-edit', upstreamSha);
        git('push', 'origin', 'main');
        const result = run();
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(summary, 'utf8')).toContain('already included in main');
        expect(git('ls-remote', '--heads', 'origin', 'sync/*')).toBe('');
    });
});
