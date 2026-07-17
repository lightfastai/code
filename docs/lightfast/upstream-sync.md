# Upstream synchronization

Lightfast Code is a merge-based public fork of `pingdotgg/t3code`. Shared `main` history is never
rebased or force-pushed. Upstream commits are merged into a short-lived integration branch and
reviewed through a pull request before they reach Lightfast `main`.

## Remote and branch invariants

A maintainer checkout should report this topology:

```text
origin    https://github.com/lightfastai/code.git
upstream  https://github.com/pingdotgg/t3code.git (fetch)
upstream  DISABLED (push)
```

Verify it without printing credentials:

```bash
git remote -v
git remote get-url --push upstream
gh repo view lightfastai/code --json isFork,parent,defaultBranchRef,visibility
```

Expected results are a public fork whose parent is `pingdotgg/t3code`, default branch `main`, and an
upstream push URL of `DISABLED`. Do not enable upstream pushes.

## Automated integration

`.github/workflows/lightfast-upstream-sync.yml` runs daily at 04:17 UTC and is also manually
dispatchable. It:

1. checks out full Lightfast `main` history without persisting a GitHub write credential;
2. fetches `origin/main` and `pingdotgg/t3code:main`;
3. reuses an existing open `sync/upstream-YYYYMMDD` pull request or creates that branch from
   Lightfast `main`;
4. creates a non-fast-forward upstream merge;
5. runs the Lightfast boundary audit, `vp check`, `vp run typecheck`, `vp run test`, and mobile
   native lint when incoming upstream paths require it;
6. captures the exact candidate SHA before installing or executing merged upstream code, verifies the
   worktree still names that SHA after all gates, and uploads an immutable Git bundle plus manifest;
7. starts a separate privileged job that never checks out, installs, or executes repository code,
   independently verifies the artifact identity, exact SHA, expected refs, and commit parents; and
8. pushes only that verified SHA to the integration branch before opening or updating the pull request
   with incoming commits and gate evidence.

Trigger and inspect it with:

```bash
gh workflow run lightfast-upstream-sync.yml --repo lightfastai/code
gh run list --repo lightfastai/code --workflow lightfast-upstream-sync.yml --limit 5
gh run watch --repo lightfastai/code <run-id>
```

The merge and validation job has only `contents: read` and `pull-requests: read`, and checkout does
not persist its credential. Only the publication job receives `contents: write` and
`pull-requests: write`; it runs on a fresh runner and never executes the merged tree. Branch
protection on `main` must require a pull request and must disallow force pushes and deletion; the
workflow never needs a main-branch bypass.

## Boundary audit

`config/lightfast-upstream-boundary.json` classifies changed files as Lightfast-owned paths,
intentional application bridges, shared surfaces, or unexpected upstream divergence. Run the same
audit locally after constructing an upstream merge:

```bash
git fetch --prune upstream main
node scripts/lightfast-upstream-audit.ts --base upstream/main --head HEAD
```

An `unexpected` path fails the workflow. Prefer moving Lightfast functionality into
`packages/lightfast-*`, `apps/*/src/lightfast/`, dedicated sidecars, or `docs/lightfast/`. When an
upstream-owned file really is a permanent bridge, update the policy and its tests intentionally in
the same pull request; do not suppress the result ad hoc.

## Conflict recovery

When Git reports semantic conflicts, the workflow aborts the merge and commits a dated brief under
`docs/lightfast/upstream-conflicts/`. The integration pull request remains a draft.

Resolve it in a clean maintainer checkout:

```bash
git fetch origin upstream
git switch --track origin/sync/upstream-YYYYMMDD
git merge --no-ff upstream/main
```

If that local branch already exists, switch to it only after confirming it has no unpublished
changes, then fast-forward it from `origin/sync/upstream-YYYYMMDD` before starting the merge.

Resolve each path documented by the conflict brief, preserving both upstream behavior and the
Lightfast capability boundary. Then run the boundary audit and all gates shown above, commit the
merge resolution, and push the same integration branch. Convert the pull request from draft only
after every required check passes.

Do not resolve conflicts by rebasing published `main`, force-pushing the integration branch, copying
an upstream tree over Lightfast files, or editing vendored `.repos/` content. If upstream changes a
vendored dependency configured by this repository, update the normal dependency and run
`bun run sync:repos --repo <id>` so the read-only reference subtree matches it.

## Review checklist

- The pull request base is `lightfastai/code:main` and the head is `sync/upstream-YYYYMMDD`.
- The merge commit retains the exact upstream parent.
- Bridge and shared-surface changes are called out explicitly.
- No `.env`, credential, local trace, generated report, or personal workspace file is present.
- Required checks and review approval are satisfied.
- `main` remains protected and upstream push remains disabled after the merge.
