#!/usr/bin/env bash

# Prepare one integration branch per stable upstream release using the current fork as the base.
set -euo pipefail

summary() {
    printf '%s\n' "$@" | tee -a "$GITHUB_STEP_SUMMARY"
}

published_tags=$(gh api --paginate "repos/$UPSTREAM_REPOSITORY/releases?per_page=100" \
    --jq '.[] | select(.draft == false and .prerelease == false) | .tag_name')
tag=$(printf '%s\n' "$published_tags" | awk '/^v[0-9]+\.[0-9]+\.[0-9]+$/' | sort -V | tail -n 1)
if [[ -z "$tag" ]]; then
    summary 'No stable upstream release was found.'
    exit 1
fi

# Keep upstream tags out of the fork's release namespace.
upstream_ref="refs/upstream/releases/$tag"
git fetch --no-tags "$UPSTREAM_GIT_URL" "refs/tags/$tag:$upstream_ref"
upstream_sha=$(git rev-parse "$upstream_ref^{commit}")
git fetch --no-tags origin refs/heads/main
base_sha=$(git rev-parse FETCH_HEAD)
release_url="https://github.com/$UPSTREAM_REPOSITORY/releases/tag/$tag"

if git merge-base --is-ancestor "$upstream_sha" "$base_sha"; then
    summary "[$tag]($release_url) is already included in main."
    exit 0
fi

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
branch="sync/upstream-$tag"
owner=${GITHUB_REPOSITORY%%/*}
existing_pr=$(gh api --method GET "repos/$GITHUB_REPOSITORY/pulls" \
    -f "head=$owner:$branch" -f base=main -f state=all --jq '.[0].html_url // empty')
if [[ -n "$existing_pr" ]]; then
    summary "The integration pull request for [$tag]($release_url) already exists." "$existing_pr"
    exit 0
fi

# If only the PR step failed last time, reuse its branch without overwriting anyone's work.
remote_branch=$(git ls-remote --heads origin "refs/heads/$branch")
if [[ -n "$remote_branch" ]]; then
    git fetch --no-tags origin "refs/heads/$branch"
    if ! git merge-base --is-ancestor "$upstream_sha" FETCH_HEAD; then
        summary "Branch \`$branch\` already exists and does not contain \`$upstream_sha\`."
        exit 1
    fi
else
    # Run the helper from the trusted workflow checkout, even if the merge updates its path.
    git show "HEAD:dev/upstreamSync/mergeReleaseMetadata.mjs" > "$scratch/mergeReleaseMetadata.mjs"
    git switch --create "$branch" "$base_sha"
    git config --local user.name 'github-actions[bot]'
    git config --local user.email '41898282+github-actions[bot]@users.noreply.github.com'
    if ! git -c rerere.enabled=false -c merge.autoStash=false merge --no-commit --no-ff "$upstream_sha"; then
        if ! git rev-parse --verify -q MERGE_HEAD >/dev/null; then
            exit 1
        fi
    fi

    # These files control which workflows can run and where this fork deploys.
    git restore --source="$base_sha" --staged --worktree -- .github wrangler.jsonc realeco-release deploy/docker/VERSION
    node "$scratch/mergeReleaseMetadata.mjs" "$base_sha" "$scratch"
    conflicts=$(git diff --name-only --diff-filter=U)
    if [[ -n "$conflicts" ]]; then
        git merge --abort
        summary "### Merge conflicts for [$tag]($release_url)" \
            '' "Upstream commit \`$upstream_sha\`" '' '```text' "$conflicts" '```'
        exit 1
    fi

    git commit --no-edit
    git push origin "HEAD:refs/heads/$branch"
fi

body="$scratch/pull-request.md"
cat >"$body" <<BODY
Merge [$tag]($release_url) into the fork.

Upstream commit \`$upstream_sha\`

Approve the GitHub Actions checks from the pull request if GitHub requests approval. The checks cover unit tests, the Worker build and local D1 migrations.

Check upstream workflow changes for build steps this fork needs to carry over. Verify shared music login and the desktop update feed before merging. Use a merge commit so future runs can recognize the upstream release.
BODY
pr_url=$(gh pr create --repo "$GITHUB_REPOSITORY" --base main --head "$branch" \
    --title "Sync upstream $tag" --body-file "$body")
summary "Opened the integration pull request for [$tag]($release_url)." "$pr_url"
