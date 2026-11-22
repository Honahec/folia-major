// shared/realecoReleaseMetadata.cjs
// Validates the three version sources that authorize a Realeco release.

const RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const FORK_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+-fork\.[1-9][0-9]*$/;
const RELEASE_FILE_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+\r?\n?$/;

function validateRealecoReleaseMetadata({ commitMessage, releaseFileContent, packageVersion, forkRelease = false }) {
  if (forkRelease) {
    if (!FORK_VERSION_PATTERN.test(packageVersion)
        || ![packageVersion, packageVersion + '\n'].includes(releaseFileContent)
        || commitMessage !== `release: v${packageVersion}`) {
      throw new Error('Fork releases require matching A.B.C-fork.N metadata and an exact release commit.');
    }
    return packageVersion;
  }

  if (!RELEASE_FILE_PATTERN.test(releaseFileContent)) {
    throw new Error('realeco-release must contain exactly one A.B.C version line.');
  }

  const commitMatch = /^release: v([0-9]+\.[0-9]+\.[0-9]+)$/.exec(commitMessage);
  if (!commitMatch) {
    throw new Error('Current complete commit message must exactly match release: vA.B.C.');
  }

  const releaseFileVersion = releaseFileContent.trim();
  const commitVersion = commitMatch[1];
  if (!RELEASE_VERSION_PATTERN.test(packageVersion)) {
    throw new Error('package.json version must be a plain A.B.C version.');
  }
  if (commitVersion !== releaseFileVersion || packageVersion !== releaseFileVersion) {
    throw new Error(`Release versions must match: commit=${commitVersion}, realeco-release=${releaseFileVersion}, package.json=${packageVersion}.`);
  }

  return releaseFileVersion;
}

module.exports = {
  validateRealecoReleaseMetadata,
};
