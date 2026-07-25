# PR #1 restart packet

Last updated: 2026-07-25 (Australia/Melbourne)

This document is the durable cold-start handoff for
[Lightfast Code PR #1](https://github.com/lightfastai/code/pull/1). It is written so work can resume
without the Codex conversation that produced the current branch.

## Canonical state

- Repository: `lightfastai/code`
- Pull request: `#1` — `feat: add a local-first personal study OS`
- Head branch: `feat/personal-study-os`
- Base branch: `main`
- Upstream reference: `pingdotgg/t3code`
- PR posture: open draft; do not mark ready or merge until every required checkbox in the PR
  description and [pre-merge task list](./pending-tasks.md) is resolved.
- Integration policy: merge accepted upstream changes through the guarded workflow. Do not rebase,
  force-push, or rewrite the published feature-branch history.

The PR description is the authoritative merge checklist. This document is the authoritative
restart sequence.

## What has been proven locally

The core direction has passed an end-to-end personal-use smoke test:

- text chat streams and settles correctly;
- an agent can create and publish a standard nbformat-compatible notebook artifact in chat;
- the notebook uses a real isolated Jupyter `ipykernel`;
- a Python cell executed and returned `30`;
- saving produced a new immutable notebook revision;
- a semantic 3D artifact rendered in chat and supported orbit, zoom, and camera reset.

The notebook is not an embedded JupyterLab frontend. It is a custom chat-native React renderer over
standard `.ipynb` data and a real Jupyter kernel. Preserve that separation unless an explicit
product decision changes it.

## Resume in a fresh checkout or conversation

From the repository root:

```bash
git fetch origin
git switch feat/personal-study-os
git pull --ff-only origin feat/personal-study-os
git status --short
gh pr view 1 --repo lightfastai/code
```

Then read, in order:

1. `AGENTS.md`
2. this restart packet;
3. the PR description;
4. [the pre-merge task list](./pending-tasks.md);
5. [the local operator and test runbook](./local-testing.md).

Install and start the core stack:

```bash
vp i
cp .env.example .env
docker build --tag lightfast/notebook-runtime:0.1.0 apps/notebook-runtime
vp run dev
```

Keep all provider, LiveKit, Deepgram, and local library credentials in the untracked `.env` file.
Never commit pairing tokens, provider credentials, `NOTEBOOK_RUNTIME_TOKEN`, books, or browser
state.

## First actions after resuming

1. Confirm the PR is still open and draft and that the local branch matches its head SHA.
2. Inspect new upstream commits and use the guarded merge workflow before beginning feature work.
3. Run `vp check` and `vp run typecheck` to establish a fresh local baseline.
4. Build a fresh notebook-runtime image and repeat the notebook live gate from the runbook.
5. Smoke-test text chat, notebook create/run/save/reconnect, and 3D interaction before expanding
   scope.
6. Work through the PR's required-before-merge checklist. Update the PR checkbox and attach exact
   validation evidence as each item is completed.
7. Re-run the complete merge-candidate suite on one exact final SHA before removing draft status.

## Last known validation checkpoint

On remote head `f842e3c3950de75aabe640831d941db3512649e5`, hosted CI passed Release
Smoke, Check, Mobile Native Static Analysis, and Test. The serialized product suite reported
4,924 passing tests and 10 skipped tests.

After that remote checkpoint, the local smoke-test pass added focused fixes for:

- provider runtime event lifetime;
- visibility of artifact-bearing messages in settled turns;
- atomic notebook creation, immutable persistence, and publication;
- the corresponding contracts and regression tests.

Those fixes must be present on the PR branch before relying on the latest smoke-test results. Check
the current PR head and commit history rather than assuming the historical SHA above is still
current.

## Deliberately excluded local material

Do not automatically stage unrelated local-only paths such as `.agents/`, `NOTES.md`,
`docs/superpowers/plans/`, `skills-lock.json`, or `workflows/`. Reassess them separately if they
still exist. They were not part of the validated PR #1 follow-up.

## Paste this into a new Codex conversation

> Continue Lightfast Code PR #1 from
> `docs/lightfast/pr-1-restart.md`. Read `AGENTS.md`, the PR description,
> `docs/lightfast/pending-tasks.md`, and `docs/lightfast/local-testing.md` before acting. Verify the
> local and remote `feat/personal-study-os` heads and inspect the working tree. Treat every unchecked
> PR item as required before merge. Preserve the guarded merge-based upstream workflow; do not
> rebase or force-push published history. Start by re-establishing the validation baseline and then
> continue the highest-priority incomplete checklist item.
