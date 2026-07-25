# Lightfast Code

Lightfast Code is a local-first workspace for coding agents and personal study. It is a public,
product-oriented fork of [T3 Code](https://github.com/pingdotgg/t3code) that keeps the upstream
chat experience while adding native study tools, voice sessions, interactive 3D artifacts, and
executable Jupyter notebooks.

The project is early. Prefer source builds for development and keep important work in version
control.

## What is different in this fork

- Notebook artifacts live in chat, use immutable revisions, and render code, Markdown, tables,
  images, sanitized rich output, and tracebacks.
- Python runs in a local Docker sidecar with no network, a read-only root filesystem, bounded
  resources, and no host-workspace mount by default.
- Users can run visible notebook cells directly. Agent execution is denied until it is explicitly
  enabled for that thread, while notebook publication remains available.
- Study documents, grounded voice sessions, semantic 3D scenes, hash-chained traces, and offline
  evals share one local-first capability layer.
- A scheduled integration workflow merges upstream T3 Code into reviewable pull requests without
  rewriting Lightfast history.

See [the approved architecture](./docs/superpowers/specs/2026-07-16-lightfast-fork-notebook-design.md)
for the capability, persistence, and security boundaries.

## Run from source

Prerequisites:

- Node.js `24.13.1` or another version accepted by `package.json`
- pnpm `11.10.0`
- [Vite+](https://viteplus.dev/guide/) (`vp`)
- Docker Desktop or a compatible Docker Engine for notebook execution
- at least one authenticated provider: Codex, Claude, Cursor, or OpenCode

Install and start the app:

```bash
vp i
cp .env.example .env
docker build --tag lightfast/notebook-runtime:0.1.0 apps/notebook-runtime
vp run dev
```

The development runner chooses an available server/web port pair and opens the web app. Pass
`--no-browser` to the runner when starting it for automation:

```bash
vp run dev --no-browser
```

Provider authentication remains local to the provider CLI:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

Do not put provider credentials in `.env.example` or commit a local `.env` file. Notebook runtime
credentials are generated internally for each container and are never operator configuration.

## Operate and verify

- [Notebook Docker runtime runbook](./docs/lightfast/notebook-runtime.md)
- [Local operator and test runbook](./docs/lightfast/local-testing.md)
- [Core-cutoff pending tasks](./docs/lightfast/pending-tasks.md)
- [Upstream synchronization runbook](./docs/lightfast/upstream-sync.md)
- [Environment example](./.env.example)
- [Documentation index](./docs/README.md)

Before publishing changes, run the repository gates:

```bash
vp check
vp run typecheck
vp run lint:mobile
vp test
```

The Python sidecars and live Docker runtime have additional checks documented in the notebook
runbook. `vp test` is the built-in Vite+ test command; use `vp run test` only when the recursive
package script is specifically required.

## Fork relationship

`lightfastai/code` preserves GitHub fork lineage from `pingdotgg/t3code`. The local `origin` remote
is the Lightfast fork; `upstream` is fetch-only. Lightfast `main` is merge-based and protected from
force pushes and deletion. Upstream changes arrive through `sync/upstream-YYYYMMDD` integration
pull requests.

This repository remains MIT licensed. T3 Code and its contributors retain attribution for the
upstream work on which Lightfast Code is built.
