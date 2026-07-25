# Lightfast local operator and test runbook

This runbook is for a local source checkout. Keep credentials in an untracked `.env` file or an
absolute-path environment file; the placeholders below are deliberately non-secret. Do not add
provider credentials or `NOTEBOOK_RUNTIME_TOKEN` to tracked files.

## Web and server

Install the workspace, create a local environment file, build the notebook image, and start the
combined development stack from the repository root:

```bash
vp i
cp .env.example .env
docker build --tag lightfast/notebook-runtime:0.1.0 apps/notebook-runtime
vp run dev
```

The development runner chooses an available web/server port pair. For a non-browser session use:

```bash
vp run dev --no-browser
```

Authenticate the provider CLI locally before opening a provider-backed thread (`codex login`,
`claude auth login`, `cursor-agent login`, or `opencode auth login`).

Run the standard repository gates before handing off a change:

```bash
vp check
vp run typecheck
vp run lint:mobile
vp test
```

`vp test` is the built-in Vite+ test command. Use `vp run test` only when the recursive `test`
package script is specifically required.

## LiveKit voice and semantic 3D scenes

In the untracked `.env` file, set only real local values for the server-side LiveKit transport and
the immutable study library. The client never receives the API secret:

```dotenv
T3_STUDY_LIBRARY=/absolute/path/to/study-library
T3_VOICE_LIVEKIT_URL=wss://your-project.livekit.cloud
T3_VOICE_LIVEKIT_API_KEY=replace-locally
T3_VOICE_LIVEKIT_API_SECRET=replace-locally
T3_VOICE_AGENT_NAME=t3-study-voice
GROQ_MAX_COMPLETION_TOKENS=600
```

Run the sidecar from a separate terminal, using an absolute path to the untracked environment
file:

```bash
cd apps/voice-agent
T3_STUDY_LIBRARY="$HOME/.t3/study-library" \
T3_VOICE_ENV_FILE=/absolute/path/to/.env \
uv run python agent.py dev
```

Run its local test suite and the web disconnect regression from the repository root:

```bash
cd apps/voice-agent
uv run pytest -q
cd ../..
vp test apps/web/src/components/chat/ComposerVoiceControl.test.tsx
```

For a live acceptance check, select one or more imported study documents, start a voice session,
and ask for an explanation that needs a diagram. Confirm that the web composer replaces the live
semantic 3D scene (rather than executing generated JavaScript), then disconnect normally. The
scene must disappear without an extra local disconnect; reconnect and confirm a new scene starts
at a fresh generation and can replace the old scene. Inspect the resulting trace with the study
commands below. The component regression above covers the sequence-5 replacement, natural
disconnect, and a reconnect that accepts sequence 0.

## Notebook Docker runtime

Run the contract checks, create a fresh image tag, and exercise the live Docker gate. The live
gate intentionally uses `NOTEBOOK_RUNTIME_IMAGE`; the server itself uses
`LIGHTFAST_NOTEBOOK_RUNTIME_IMAGE` when a non-default image is selected.

```bash
cd apps/notebook-runtime
uv run ruff check .
uv run ruff format --check .
uv run pytest -q
cd ../..

docker build --tag lightfast/notebook-runtime:cutoff-$(git rev-parse --short HEAD) apps/notebook-runtime
docker image inspect lightfast/notebook-runtime:cutoff-$(git rev-parse --short HEAD) --format '{{.Id}}'
NOTEBOOK_RUNTIME_LIVE=1 \
NOTEBOOK_RUNTIME_IMAGE=lightfast/notebook-runtime:cutoff-$(git rev-parse --short HEAD) \
vp test apps/server/src/notebook/NotebookRuntimeManager.live.test.ts
```

To run the app against that fresh image, put its literal tag in the untracked `.env` file, then
start the development stack:

```dotenv
LIGHTFAST_NOTEBOOK_RUNTIME_IMAGE=lightfast/notebook-runtime:cutoff-REPLACE_WITH_GIT_SHORT_SHA
```

```bash
vp run dev --no-browser
```

After opening a notebook, inspect only Lightfast-owned containers. The expected book mounts are
read-only `/books/book-N`; `NetworkMode` is `none`, `ReadonlyRootfs` is `true`, and `CapDrop`
contains `ALL`:

```bash
docker ps --filter label=lightfast.notebook.project \
  --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
docker inspect --format '{{json .HostConfig}}' <container-id>
docker inspect --format '{{json .Mounts}}' <container-id>
```

Stop the server before cleanup. First audit for leftovers; only if it is stopped, remove the
reported Lightfast-labelled containers:

```bash
docker ps --all --quiet --filter label=lightfast.notebook.project
pgrep -fl 'apps/notebook-runtime|python -m runtime' || true
docker ps --all --quiet --filter label=lightfast.notebook.project \
  | while IFS= read -r container_id; do docker rm --force "$container_id"; done
```

## Study library, traces, and evals

Choose an absolute local library path; it may be a Git/Git-LFS-backed books checkout shared by the
Mac and sync services. Import a document, list it, copy its full SHA-256 ID from the list, and tag
it. The source CLI is used directly so these commands work from this checkout without a globally
installed `t3` binary:

```bash
export T3_STUDY_LIBRARY=/absolute/path/to/study-library
node apps/server/src/bin.ts study import /absolute/path/to/linear-algebra.pdf --tag math --tag vectors
node apps/server/src/bin.ts study list
node apps/server/src/bin.ts study tag <full-64-character-document-id> --tag revision
vp test apps/server/src/study/StudyLibrary.test.ts \
  apps/server/src/study/StudyLoop.test.ts \
  apps/server/src/study/NotebookStudyEval.test.ts
```

After a voice or notebook run, list and verify its immutable trace. Use the included dataset and
copy its example bindings to an untracked path before replacing the sample run ID. Run baseline and
candidate reports against the same dataset before comparing them:

```bash
node apps/server/src/bin.ts study trace list
node apps/server/src/bin.ts study trace verify study-ROOM_ID
cp apps/voice-agent/evals/grounded-voice.bindings.example.json /absolute/path/to/trace-bindings.json
node apps/server/src/bin.ts study eval run apps/voice-agent/evals/grounded-voice.example.json \
  --bindings /absolute/path/to/trace-bindings.json
node apps/server/src/bin.ts study eval compare /absolute/path/to/baseline-report.json \
  /absolute/path/to/candidate-report.json
```

The eval command prints each report path. A comparison rejects mismatched dataset/grader versions,
regressions, and a failing candidate.

## Expo and iPad

Use the development variant and inspect its public manifest before native work. Do not add secrets
to this configuration: public Clerk and observability values are read from local environment values
by `apps/mobile/app.config.ts`; the server-side LiveKit secrets above stay off the device.

```bash
cd apps/mobile
EXPO_NO_DOTENV=1 APP_VARIANT=development node_modules/.bin/expo config --type public
EXPO_NO_DOTENV=1 APP_VARIANT=development node_modules/.bin/expo prebuild --platform ios --no-install
cd ../..
vp run --filter @t3tools/mobile dev:client
```

For a simulator or connected iPad development client, prebuild and run iOS from the repository
root. EAS development builds use the same `development` profile in `apps/mobile/eas.json`:

```bash
vp run --filter @t3tools/mobile ios:dev
vp run --filter @t3tools/mobile eas:ios:dev
```

Current limitation: a full local iOS simulator build is blocked by the pre-existing
`T3TerminalNative` Swift module failure (`SwiftEmitModule` / `EmitSwiftModule` for
`T3TerminalNative`). The public config and iOS prebuild commands above are the currently reliable
local checks; do not treat simulator build failure as a notebook renderer regression until that
native module is fixed.

Notebook execution on iPad requires an authenticated paired Mac running the server and Docker
runtime. On a real iPad, open a notebook artifact and verify loading/retry, cached offline state,
per-cell Run, Interrupt, Restart/Reconnect, immutable Save, referenced/latest revision navigation,
read-only mounted-book labels, and the agent-only execution permission. While the paired Mac is
offline or reconnecting, cached content must remain visible and every mutation must be disabled.
