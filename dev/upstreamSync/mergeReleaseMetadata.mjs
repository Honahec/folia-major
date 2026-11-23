import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Merge upstream dependency changes while keeping the fork's version and update feed.

const [fork, scratch] = process.argv.slice(2);
const readAt = (ref, path) => JSON.parse(execFileSync('git', ['show', ref + ':' + path], { encoding: 'utf8' }));
const previous = readAt(fork, 'package.json');
const syncServerVersion = readAt(fork, 'sync-server/package.json').version;
const normalize = (value, filename) => {
    const version = filename.startsWith('sync-server/') ? syncServerVersion : previous.version;
    value.version = version;
    if (filename === 'package.json') {
        value.build.publish = previous.build.publish;
    } else if (filename.endsWith('package-lock.json')) {
        value.packages[''].version = version;
    }
    return JSON.stringify(value, null, 2) + '\n';
};

for (const filename of ['package.json', 'package-lock.json', 'sync-server/package.json', 'sync-server/package-lock.json']) {
    const conflicts = execFileSync('git', ['ls-files', '-u', '--', filename], { encoding: 'utf8' });
    if (conflicts) {
        const stages = [...conflicts.matchAll(/^100644 [a-f0-9]+ ([123])\t/gm)].map(match => match[1]);
        if (stages.join('') !== '123') continue;
        const [basePath, forkPath, upstreamPath] = stages.map(stage => {
            const path = join(scratch, filename.replace('/', '-') + '.' + stage);
            writeFileSync(path, normalize(readAt(':' + stage, filename), filename));
            return path;
        });
        try {
            execFileSync('git', ['merge-file', forkPath, basePath, upstreamPath], { stdio: 'ignore' });
        } catch (error) {
            if (typeof error.status !== 'number' || error.status < 1 || error.status > 127) throw error;
            continue;
        }
        writeFileSync(filename, readFileSync(forkPath));
    } else {
        if (!lstatSync(filename).isFile()) throw new Error(filename + ' must be a regular file');
        writeFileSync(filename, normalize(JSON.parse(readFileSync(filename, 'utf8')), filename));
    }
    execFileSync('git', ['add', '--', filename]);
}

// Keep both the installer feed and the runtime update lookup pointing to this repository.
const entry = 'electron/main.cjs';
const updateFeed = /^const FOLIA_RELEASES_URL = .+;\r?\nconst FOLIA_GITHUB_REPOSITORY = \{[\s\S]*?^\};/m;
if (!execFileSync('git', ['ls-files', '-u', '--', entry], { encoding: 'utf8' })) {
    if (!lstatSync(entry).isFile()) throw new Error(entry + ' must be a regular file');
    const previousFeed = execFileSync('git', ['show', fork + ':' + entry], { encoding: 'utf8' }).match(updateFeed)?.[0];
    const merged = readFileSync(entry, 'utf8');
    const mergedFeed = merged.match(updateFeed)?.[0];
    if (previousFeed && !mergedFeed) throw new Error('The desktop update feed moved. Review ' + entry + ' before merging upstream.');
    if (previousFeed && previousFeed !== mergedFeed) {
        writeFileSync(entry, merged.replace(updateFeed, () => previousFeed));
        execFileSync('git', ['add', '--', entry]);
    }
}
