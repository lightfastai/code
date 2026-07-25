# Lightfast Code Fork and Notebook Architecture

Date: 2026-07-16  
Status: Approved for implementation

## 1. Purpose

Lightfast Code is a public, product-oriented fork of `pingdotgg/t3code`. It must be able to absorb
upstream T3 Code changes for years while adding Lightfast-owned capabilities such as study tools,
voice, interactive 3D scenes, and executable notebook artifacts.

The design addresses two capability gaps:

1. Product changes currently cross several upstream-owned files, making each upstream update more
   likely to conflict.
2. Chat artifacts can render interactive 3D scenes, but there is no general extension boundary for
   adding new artifact kinds or long-lived runtimes such as Jupyter kernels.

Success means that an upstream update arrives through a reviewable integration pull request, most
Lightfast code lives outside upstream-owned modules, new artifact kinds register without expanding a
central union or switch, and notebook code runs through a local isolated runtime with reproducible
outputs.

## 2. Evidence and Decisions

### Known

- `pingdotgg/t3code` is a public MIT-licensed repository whose default branch is `main`.
- The `lightfastai` organization exists and the current GitHub account can create and administer
  repositories in it.
- `lightfastai/code` and `lightfastai/t3code` do not currently exist.
- The current checkout is shallow, has only an `upstream` remote, and its local `main` branch belongs
  to an earlier standalone spatial-tutor prototype rather than the T3 Code history.
- T3 Code already has typed orchestration events, a shared schema package, server and web boundaries,
  and an initial 3D artifact publisher and renderer.
- Jupyter notebooks use nbformat documents containing stable cell IDs, code or Markdown sources,
  execution counts, and MIME-bundle outputs.
- Jupyter kernels execute requests asynchronously and publish ordered status, stream, display, result,
  and error messages before returning to idle.

### Approved decisions

- Publish a public GitHub fork, preserve its GitHub fork relationship, and rename it to
  `lightfastai/code`.
- Use a merge-based product fork. Shared `main` is never rebased or force-pushed.
- Rebase short-lived Lightfast feature branches onto Lightfast `main`; merge upstream into Lightfast
  `main` through integration pull requests.
- Isolate Lightfast capabilities behind three stable application bridges and versioned capability
  packages.
- Use an open artifact envelope with runtime validation by `kind` and `schemaVersion`.
- Implement notebooks as a native chat artifact backed by real Jupyter kernels in a local Docker
  runtime.
- Treat browser Pyodide as a later offline fallback, not the first execution backend.
- Permit users to execute notebook cells directly. Agent execution requires an explicit per-thread
  permission.

## 3. Repository Topology

The configured remotes will be:

```text
origin    https://github.com/lightfastai/code.git
upstream  https://github.com/pingdotgg/t3code.git
```

Branches have distinct responsibilities:

- `main`: releasable Lightfast product history. It preserves upstream ancestry and is protected.
- `feat/*`: short-lived Lightfast work rebased onto the current Lightfast `main` before merging.
- `sync/upstream-YYYYMMDD`: ephemeral branches created for upstream integration pull requests.
- `archive/spatial-tutor-prototype`: the unrelated current local `main`, retained only as an archive
  until its useful history has been accounted for.

The initial publication sequence is:

1. Create `lightfastai/t3code` as GitHub's public fork of `pingdotgg/t3code`.
2. Rename that fork to `lightfastai/code`, preserving GitHub's fork relationship and redirects.
3. Unshallow the local T3 Code checkout and verify the upstream merge base.
4. Archive the unrelated local `main` under `archive/spatial-tutor-prototype`.
5. Add `origin`, fetch it, and reset the local product topology without discarding working-tree
   changes.
6. Commit the existing study, voice, canvas, and artifact work on its feature branch.
7. Push the feature branch and merge it into `lightfastai/code:main` through a reviewed pull request.

Personal workspace files are excluded from publication: `.agents/`, `NOTES.md`, `skills-lock.json`,
and `workflows/`. Secrets and local `.env` files are never committed.

## 4. Upstream Integration

A scheduled and manually dispatchable GitHub workflow will:

1. Fetch `pingdotgg/t3code:main` with full history.
2. Exit successfully when it is already contained in Lightfast `main`.
3. Create an ephemeral `sync/upstream-YYYYMMDD` branch from Lightfast `main`.
4. Merge `upstream/main` without rewriting published history.
5. Run formatting, typechecking, unit tests, mobile native checks when applicable, and Lightfast
   boundary checks.
6. Open a pull request summarizing upstream commits, conflicts, changed bridge files, and validation.

The workflow never pushes directly to `main`. Conflict resolution happens once in the integration
pull request and remains recorded in history.

An upstream-diff audit classifies changes relative to the merge base:

- Lightfast-owned paths are expected: `packages/lightfast-*`, `apps/*/src/lightfast`, dedicated
  Lightfast sidecars, capability tests, and Lightfast documentation.
- Declared bridge files are permitted but reported individually.
- Changes to other upstream-owned paths fail the audit unless the bridge allowlist is intentionally
  updated in the same pull request.
- Dependency manifests, lockfiles, release metadata, and branding files are reported as shared
  surfaces rather than silently ignored.

This audit does not claim that all upstream conflicts can be eliminated. It makes divergence explicit,
small, and reviewable.

## 5. Capability Boundary

Upstream applications integrate Lightfast through three stable bridges:

```text
apps/server/src/lightfast/register.ts
apps/web/src/lightfast/register.tsx
apps/mobile/src/lightfast/register.ts
```

Startup code imports each bridge once. Lightfast capabilities do not add feature-specific switches to
upstream orchestration or renderers.

The workspace contains:

```text
packages/lightfast-capability-core/
packages/lightfast-artifact-3d/
packages/lightfast-artifact-notebook/
packages/lightfast-study/
apps/voice-agent/
apps/notebook-runtime/
```

`lightfast-capability-core` defines environment-neutral artifact envelopes, definition types, registry
interfaces, namespaced capabilities, and safe unknown-artifact behavior. Individual capabilities use
explicit subpath exports such as `./contracts`, `./server`, `./web`, and `./mobile`; importing one
environment must not evaluate code intended for another.

Each artifact definition supplies:

- a globally unique `kind`;
- supported schema versions;
- an Effect Schema payload validator;
- namespaced capability names;
- optional server tools and command handlers;
- web and mobile renderer registrations;
- migrations between supported payload versions;
- contract, server, and renderer tests.

The wire envelope is stable and open-ended:

```ts
interface ArtifactEnvelope {
  readonly type: "artifact";
  readonly id: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly title: string;
  readonly payload: JsonValue;
  readonly capabilities?: readonly string[];
  readonly provenance?: readonly ArtifactSourceReference[];
}
```

The envelope validates size limits and common metadata. The registry then validates the payload and
capabilities for the registered `kind + schemaVersion`. The server refuses to publish an invalid or
unregistered artifact. Clients preserve unknown artifacts and render a non-crashing fallback with the
kind and version.

The existing 3D artifact becomes the reference capability. Its contracts, publication tool, server
handler, web renderer, and tests move together before notebook code is introduced. Voice and study
remain separate runtime capabilities but use the same registration and trace boundaries.

## 6. Notebook Document Model

The notebook capability uses an nbformat 4-compatible safe subset. A document contains:

- a stable document ID;
- an immutable revision ID and SHA-256 content hash;
- nbformat major and minor versions;
- a kernel specification;
- ordered Markdown and code cells with unique nbformat-compatible cell IDs;
- normalized string sources;
- allowlisted cell metadata;
- standard output records and MIME bundles.

Large notebook documents are stored in the authenticated local content store rather than duplicated in
the chat event log. The artifact payload contains the document ID, exact revision ID, content hash,
kernel requirement, and initial view. Content hashes are verified whenever a revision is loaded.

A chat message always references an immutable revision. Editing or running a notebook creates a local
working copy. Saving produces a new immutable revision. When a newer revision exists, the original chat
artifact can offer “open latest” while retaining “view referenced revision.” Import and export preserve
standard `.ipynb` interoperability.

Supported v1 outputs are:

- stdout and stderr streams;
- execution results and error tracebacks;
- `text/plain`, sanitized Markdown, and `application/json`;
- PNG and sanitized SVG images;
- table data;
- Plotly and Vega specifications rendered by known client renderers;
- sanitized `text/html` inside a sandboxed iframe without arbitrary scripts.

Unsupported MIME types remain stored and can be exported, but are not executed or injected into the
application DOM.

## 7. Notebook Runtime

`apps/notebook-runtime` is a versioned Python sidecar built into a pinned Docker image. It uses the
official Jupyter client protocol to manage kernels. The T3/Lightfast server is the only component that
can authenticate to it; web and mobile clients communicate through existing authenticated RPC and
event channels.

The initial lifecycle is one resource-limited runtime container per project, with separate kernel
processes per active notebook session. This amortizes container startup while preserving namespace
separation between notebooks. Idle kernels and containers are reaped after configurable timeouts.

The command protocol includes:

- `notebook.session.open`;
- `notebook.cell.execute`;
- `notebook.execution.interrupt`;
- `notebook.kernel.restart`;
- `notebook.revision.save`;
- `notebook.session.dispose`.

Execution events include:

- accepted and rejected commands;
- kernel starting, busy, idle, interrupted, restarted, and terminated states;
- stdout and stderr chunks;
- display data and execution results;
- errors and structured tracebacks;
- output truncation and resource-limit events;
- revision persistence results.

Every command has a command ID. Every execution has an execution ID. Events have a monotonically
increasing session sequence. Replayed command IDs do not execute twice, and reconnecting clients resume
from their last observed sequence.

The runtime transition can be summarized as:

```math
(S_{t+1}, E_t) = K(S_t, C_t)
```

`S_t` is kernel and namespace state, `C_t` is a validated execute, interrupt, restart, save, or dispose
command, and `E_t` is the ordered output event stream. This model establishes causal and replay
requirements; it does not claim that arbitrary notebook programs terminate or behave safely without
runtime limits.

## 8. Security and Resource Policy

Notebook code is untrusted even when the application has one user. The Docker runtime uses:

- an unprivileged user and read-only root filesystem;
- dropped Linux capabilities and `no-new-privileges`;
- no Docker socket inside the container;
- bounded CPU, memory, process count, disk usage, execution duration, and output bytes;
- a temporary filesystem for transient files;
- a dedicated writable notebook workspace;
- explicitly selected books mounted read-only;
- no host workspace mount unless the user grants it for that project;
- network disabled by default and an explicit project setting to enable it;
- pinned image and Python dependency versions.

Rich outputs are treated as untrusted input. HTML uses a sandboxed iframe, SVG is sanitized, external
resource loads are blocked by default, and arbitrary JavaScript MIME bundles are not executed.

Users may always run visible cells. Agent tools `artifact_publish_notebook`,
`notebook_execute_cell`, and `notebook_execute_all` require the thread-level notebook execution grant.
The UI shows agent-generated code and active executions, permits interruption, and records commands,
outputs, durations, limits, skill version, and runtime identity in the existing study trace system.

## 9. Client Experience

The native chat renderer provides:

- editable Markdown and code cells;
- add, remove, reorder, and duplicate cell actions;
- run cell, run above, run all, interrupt, and restart controls;
- per-cell execution state and count;
- streaming outputs below the executing cell;
- kernel status, environment identity, and resource-limit indicators;
- save revision, compare with referenced revision, import, and export;
- collapsed and expanded chat layouts.

The Mac web and Electron clients use the local Docker runtime. The iPad client connects to the paired
Mac server through the existing authenticated local or hybrid connection. A later Pyodide backend can
implement the same command and event protocol for offline-compatible notebooks without changing the
artifact or UI contracts.

## 10. Reliability and Evaluation

Required verification includes:

- envelope and capability registry schema tests;
- known and unknown artifact renderer tests;
- migration and content-hash tests;
- `.ipynb` import/export round trips;
- execution success, stream ordering, rich output, and traceback integration tests;
- duplicate command, reconnect, interrupt, restart, timeout, output-limit, and idle-reaping tests;
- filesystem, network, user, and resource isolation tests against the Docker image;
- browser tests for editing, running, streaming, interruption, and revision persistence;
- agent-permission and trace-integrity tests;
- an upstream-sync dry run and boundary-audit fixture.

Notebook eval cases join the existing train/holdout loop. Cases bind an exact notebook revision, skill
artifact, runtime image digest, kernel package lock, and expected assertions. Candidate skills cannot be
promoted when notebook behavior regresses the holdout set or violates deterministic safety assertions.

## 11. Implementation Sequence

Implementation proceeds in dependency order:

1. Repair and publish the Git topology without losing the working tree or personal files.
2. Add upstream-sync automation, branch protections, and the divergence audit.
3. Introduce the capability core and the three application bridges.
4. Migrate 3D publication and rendering behind the capability registry.
5. Migrate study and voice registration points and confirm the existing test suite remains green.
6. Add notebook document contracts, content-addressed revisions, import/export, and a static renderer.
7. Add the Docker Jupyter runtime and ordered execution protocol.
8. Add interactive notebook controls, rich output renderers, permissions, tracing, and eval cases.
9. Verify web, Electron, paired iPad, runtime isolation, upstream sync, and complete repository gates.

Each step must leave the product runnable. The notebook UI is not permitted to bypass the runtime
protocol, and the runtime is not permitted to publish unvalidated artifact revisions.

## 12. Primary Anchors

- T3 Code repository: <https://github.com/pingdotgg/t3code>
- Jupyter messaging protocol: <https://jupyter-client.readthedocs.io/en/stable/messaging.html>
- Jupyter notebook format: <https://nbformat.readthedocs.io/en/latest/format_description.html>
- JupyterLite and Pyodide reference: <https://jupyterlite.readthedocs.io/en/stable/>

JupyterLite demonstrates that a browser kernel is a credible later backend. It is not selected for v1
because the approved requirement prioritizes real Python packages, persistent environments, and Docker
isolation on the paired Mac.
