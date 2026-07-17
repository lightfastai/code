# Notebook Docker runtime

Lightfast Code executes notebooks through the Python sidecar in `apps/notebook-runtime`. The
server owns the Docker lifecycle and communicates with the sidecar over authenticated `docker exec`
requests; browsers and mobile clients never receive the runtime credential or talk to the container
directly.

## Build and start

Build the default local image from the repository root:

```bash
docker build --tag lightfast/notebook-runtime:0.1.0 apps/notebook-runtime
docker image inspect lightfast/notebook-runtime:0.1.0 --format '{{.Id}}'
vp run dev --no-browser
```

To operate a differently tagged image, set only its reference in the untracked local `.env` file:

```dotenv
LIGHTFAST_NOTEBOOK_RUNTIME_IMAGE=lightfast/notebook-runtime:0.1.0
```

Do not set `NOTEBOOK_RUNTIME_TOKEN`. The server obtains a one-time bootstrap token from each
container, removes it from the sidecar environment before a kernel starts, and retains it only in
the owning server process.

The image is created lazily: the server starts a container when a notebook session first connects.
The default manager admits four active sessions per project and eight globally, and reaps sessions
after 15 minutes of inactivity.

## Isolation policy

Every notebook session receives a separate container with:

- networking disabled;
- all Linux capabilities dropped and `no-new-privileges` enabled;
- a read-only root filesystem and unprivileged kernel process;
- one CPU, 512 MiB memory, and a 64-process limit;
- a 64 MiB temporary directory and 256 MiB ephemeral workspace;
- a 120-second execution timeout, 10 MiB output budget, and bounded event retention;
- explicitly selected study books mounted read-only for that session only; and
- no host workspace or Docker socket mount.

Agent runs are additionally ephemeral and exclusive. Publication is allowed without execution
authority, but `notebook_execute_cell` and `notebook_execute_all` require the server-owned
`allowNotebookExecution` grant for the exact thread and immutable revision.

Notebook publication, browser runtime opens, and agent execution send only `documentIds`; they never
send host paths. For agent tools, the authoritative selection comes from the authenticated
`thread.turn.start` command, is normalized and bound to the thread before its MCP credential is
issued or reused, and defaults to an empty selection for legacy or malformed input. A tool call may
equal or narrow that server-owned selection, but can never widen it to another library book.
Publication persists only the accepted subset, so a later user Run cannot acquire authority that the
publishing turn did not have.

After authenticating the environment and project and checking that authority, the server resolves
the complete accepted selection against that environment's study-library index, verifies the exact
immutable object key, canonical real path, regular-file type, and containment under the library
object root, then passes those canonical paths to the runtime manager. Missing, malformed, unknown,
or escaping selections resolve to no book mounts; the server never broadens them to the full library
or accepts a partial selection.

Mount ownership is session/container-scoped. A session's normalized book set cannot change after its
container starts, and a sibling session in the same project receives only its own explicitly selected
books. Each canonical source object is exposed as read-only `/books/book-N`; no derived host path,
workspace path, title, or client-provided path is used as a mount source.

## Inspect a running system

The server labels every owned container without exposing document titles or source code:

```bash
docker ps --filter label=lightfast.notebook.project \
  --format 'table {{.ID}}\t{{.Names}}\t{{.Status}}'
docker inspect --format '{{json .HostConfig}}' <container-id>
docker inspect --format '{{json .Mounts}}' <container-id>
```

Expected mounts are empty or read-only `/books/book-N` bindings. `/tmp` and `/workspace` appear in
`HostConfig.Tmpfs`, not as writable host mounts. `NetworkMode` must be `none`, `ReadonlyRootfs` must
be `true`, and `CapDrop` must contain `ALL`.

Interruption stops the active execution and restart replaces the kernel process, but both retain the
same session container. Disposal, server shutdown, and idle reaping remove owned containers. After
the server has stopped, audit cleanup with:

```bash
docker ps --all --quiet --filter label=lightfast.notebook.project
pgrep -fl 'apps/notebook-runtime|python -m runtime' || true
```

Both commands should produce no runtime-owned entries. If the server was killed while Docker was
unavailable, stop the server first and remove only Lightfast-labelled leftovers:

```bash
docker ps --all --quiet --filter label=lightfast.notebook.project \
  | while IFS= read -r container_id; do docker rm --force "$container_id"; done
```

Never run that cleanup while a Lightfast server is active; it would interrupt sessions the server
still owns.

## Validation matrix

Run the Python contract tests and build the exact image that the live tests will use:

```bash
cd apps/notebook-runtime
uv run ruff check .
uv run ruff format --check .
uv run pytest -q
cd ../..

docker build --tag lightfast/notebook-runtime:task8 apps/notebook-runtime
NOTEBOOK_RUNTIME_LIVE=1 \
NOTEBOOK_RUNTIME_IMAGE=lightfast/notebook-runtime:task8 \
vp test run apps/server/src/notebook/NotebookRuntimeManager.live.test.ts
```

The live matrix proves stateful execution, rich PNG output, timeout and explicit interruption,
restart, reconnect/replay, duplicate-command idempotence, network/filesystem/token isolation,
read-only selected-book access without sibling-session inheritance, resource settings, admission
limits, cleanup retries, and zero retained containers. Focused contract and server tests additionally
cover authenticated ID-to-path resolution, malformed/unknown IDs, and path traversal.

## Troubleshooting

- `Could not launch the Docker CLI`: start Docker and confirm `docker info` succeeds for the same
  user running Lightfast Code.
- `No such image`: build the default tag or point `LIGHTFAST_NOTEBOOK_RUNTIME_IMAGE` at an image
  that exists locally.
- `Notebook runtime reached its ... session limit`: dispose inactive notebook sessions or allow the
  idle reaper to run; do not raise limits without reassessing host capacity.
- Readiness or bootstrap failures: rebuild from the current lockfile, then inspect the container
  logs before removing the labelled container.
- Cleanup failure: stop the app, restore Docker availability, run the labelled-container audit, and
  remove only the reported leftovers.
