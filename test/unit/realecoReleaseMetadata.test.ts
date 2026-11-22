import { describe, expect, it } from 'vitest';

// test/unit/realecoReleaseMetadata.test.ts

const { validateRealecoReleaseMetadata } = require('../../shared/realecoReleaseMetadata.cjs') as {
    validateRealecoReleaseMetadata: (metadata: {
        commitMessage: string;
        releaseFileContent: string;
        packageVersion: string;
        forkRelease?: boolean;
    }) => string;
};

const validMetadata = {
    commitMessage: 'release: v0.6.1',
    releaseFileContent: '0.6.1\n',
    packageVersion: '0.6.1',
};

describe('Realeco release metadata', () => {
    it('accepts a matching commit message, release file, and package version', () => {
        expect(validateRealecoReleaseMetadata(validMetadata)).toBe('0.6.1');
    });

    it('accepts matching fork releases only in the fork workflow', () => {
        const metadata = {
            commitMessage: 'release: v0.7.29-fork.1',
            releaseFileContent: '0.7.29-fork.1\n',
            packageVersion: '0.7.29-fork.1',
        };
        expect(validateRealecoReleaseMetadata({ ...metadata, forkRelease: true })).toBe('0.7.29-fork.1');
        expect(() => validateRealecoReleaseMetadata(metadata)).toThrow();
        expect(() => validateRealecoReleaseMetadata({ ...metadata, forkRelease: true, commitMessage: 'release: v0.7.29-fork.2' })).toThrow();
    });

    it.each([
        [{ ...validMetadata, commitMessage: 'release: v0.6.1\n\nnotes' }, 'complete commit message'],
        [{ ...validMetadata, releaseFileContent: 'v0.6.1\n' }, 'realeco-release'],
        [{ ...validMetadata, releaseFileContent: '0.6.2\n' }, 'Release versions must match'],
        [{ ...validMetadata, packageVersion: '0.6.1-beta.1' }, 'package.json version'],
    ])('rejects invalid metadata %#', (metadata, message) => {
        expect(() => validateRealecoReleaseMetadata(metadata)).toThrow(message);
    });
});
