import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type NotebookArtifactPayload,
  type NotebookCell as NotebookCellValue,
  type NotebookOutput as NotebookOutputValue,
} from "./contracts.ts";
import {
  addNotebookCell,
  applyNotebookRuntimeToWorkingCopy,
  applySavedNotebookRevision,
  duplicateNotebookCell,
  isNotebookWorkingCopyDirty,
  moveNotebookCell,
  openLatestNotebookRevision,
  updateNotebookCellSource,
  viewReferencedNotebookRevision,
  type NotebookWorkingCopy,
} from "./working-copy.ts";
import {
  importNotebookRevisionAndReplaceRuntime,
  isNotebookExecutionDisabled,
  isNotebookInterruptDisabled,
  isNotebookRevisionSwitchDisabled,
  loadNotebookRevisionAndConnect,
  notebookRuntimeTarget,
  replaceNotebookWorkingCopyRuntime,
  runNotebookTrackedAction,
} from "./runtime-lifecycle.ts";
import { NotebookCell } from "./NotebookCell.tsx";
import { removeNotebookCellFromRenderer } from "./notebook-cell-removal.ts";
import { planNotebookOutputRendering } from "./notebook-output-rendering.ts";
import { type NotebookRuntimeView, useNotebookWebBindings } from "./web.tsx";

const INITIAL_RUNTIME_STATE: NotebookRuntimeView = {
  kernelStatus: "disconnected",
  lastSequence: 0,
  recoveryAfterSequence: null,
  outputsByCell: new Map(),
  outputKeysByCell: new Map(),
  outputRetentionByCell: new Map(),
  executionCountByCell: new Map(),
  runningCellIds: new Set(),
  error: null,
};

let fallbackId = 0;
const randomToken = (): string => {
  const values = new Uint32Array(4);
  globalThis.crypto?.getRandomValues?.(values);
  return [...values].map((value) => value.toString(16).padStart(8, "0")).join("");
};
const nextId = (prefix: string): string => {
  fallbackId += 1;
  const token = randomToken();
  return `${prefix}-${token === "00000000000000000000000000000000" ? fallbackId : token}`
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 64);
};

const isNotebookPayload = (value: unknown): value is NotebookArtifactPayload => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.documentId === "string" &&
    typeof record.revisionId === "string" &&
    typeof record.contentHash === "string" &&
    typeof record.kernel === "object" &&
    record.kernel !== null &&
    typeof record.initialView === "object" &&
    record.initialView !== null
  );
};

export function NotebookArtifactEnvelopeRenderer({
  artifact,
}: {
  readonly artifact: ArtifactEnvelope;
}) {
  const bindings = useNotebookWebBindings();
  const payload = isNotebookPayload(artifact.payload) ? artifact.payload : null;
  const [working, setWorking] = useState<NotebookWorkingCopy | null>(null);
  const [runtime, setRuntime] = useState<NotebookRuntimeView>(INITIAL_RUNTIME_STATE);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [interruptPending, setInterruptPending] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const mounted = useRef(true);
  const lifecycleGeneration = useRef(0);
  const importInput = useRef<HTMLInputElement | null>(null);
  const runtimeTarget = working === null ? null : notebookRuntimeTarget(working);
  const sessionId = runtimeTarget?.sessionId ?? "notebook-invalid";

  const onRuntimeState = useCallback((next: NotebookRuntimeView) => {
    if (!mounted.current) return;
    setRuntime(next);
    setWorking((current) =>
      current === null ? current : applyNotebookRuntimeToWorkingCopy(current, next),
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadRevisionAndConnect = useCallback(async () => {
    if (bindings === null || payload === null) return;
    const generation = ++lifecycleGeneration.current;
    const isActive = () => mounted.current && lifecycleGeneration.current === generation;
    setRuntimeReady(false);
    try {
      const next = await loadNotebookRevisionAndConnect({
        controller: bindings.controller,
        scope: bindings.scope,
        documentId: payload.documentId,
        revisionId: payload.revisionId,
        onState: onRuntimeState,
        isActive,
        onLoadError: (error) => {
          if (isActive()) setLoadError(error);
        },
        onWorkingCopy: (next) => {
          if (!isActive()) return;
          setRuntime(INITIAL_RUNTIME_STATE);
          setWorking(next);
        },
      });
      if (isActive() && next !== null) setRuntimeReady(true);
    } catch {
      if (isActive()) setRuntimeReady(false);
      // The shared loader has already surfaced the bounded error message.
    }
  }, [bindings, onRuntimeState, payload]);

  useEffect(() => {
    void loadRevisionAndConnect();
    return () => {
      lifecycleGeneration.current += 1;
    };
  }, [loadRevisionAndConnect]);

  const runAction = useCallback(
    (label: string, action: () => Promise<void>) =>
      runNotebookTrackedAction({
        action,
        onError: (error) => {
          if (mounted.current) setActionError(error);
        },
        onPendingChange: (pending) => {
          if (mounted.current) setPendingAction(pending ? label : null);
        },
      }),
    [],
  );

  const runInterruptAction = useCallback(
    (action: () => Promise<void>) =>
      runNotebookTrackedAction({
        action,
        onError: (error) => {
          if (mounted.current) setActionError(error);
        },
        onPendingChange: (pending) => {
          if (mounted.current) setInterruptPending(pending);
        },
      }),
    [],
  );

  const transitionWorkingCopy = useCallback(
    (label: string, nextWorking: NotebookWorkingCopy) => {
      if (
        bindings === null ||
        working === null ||
        interruptPending ||
        isNotebookRevisionSwitchDisabled(pendingAction, runtime.runningCellIds)
      )
        return;
      const generation = ++lifecycleGeneration.current;
      const isActive = () => mounted.current && lifecycleGeneration.current === generation;
      void runAction(label, async () => {
        if (isActive()) setRuntimeReady(false);
        try {
          const next = await replaceNotebookWorkingCopyRuntime({
            controller: bindings.controller,
            scope: bindings.scope,
            working,
            nextWorking,
            onState: onRuntimeState,
            isActive,
            onWorkingCopy: (replacement) => {
              if (!isActive()) return;
              setRuntime(INITIAL_RUNTIME_STATE);
              setWorking(replacement);
            },
          });
          if (isActive() && next !== null) setRuntimeReady(true);
        } catch (cause) {
          if (!isActive()) return;
          setRuntimeReady(false);
          throw cause;
        }
      });
    },
    [
      bindings,
      interruptPending,
      onRuntimeState,
      pendingAction,
      runAction,
      runtime.runningCellIds,
      working,
    ],
  );

  const runCell = useCallback(
    async (cell: NotebookCellValue) => {
      if (bindings === null || runtimeTarget === null || !runtimeReady || cell.cell_type !== "code")
        return;
      await bindings.controller.executeCell({
        scope: bindings.scope,
        sessionId: runtimeTarget.sessionId,
        cellId: cell.id,
        code: cell.source,
        onState: onRuntimeState,
      });
    },
    [bindings, onRuntimeState, runtimeReady, runtimeTarget],
  );

  const visibleCells = useMemo(() => {
    if (working === null || payload === null) return [];
    if (payload.initialView.mode !== "cell") return working.document.cells;
    const selected = working.document.cells.filter(
      (cell) => cell.id === payload.initialView.cellId,
    );
    return selected.length > 0 ? selected : working.document.cells;
  }, [payload, working]);
  const outputRenderPlan = useMemo(
    () =>
      planNotebookOutputRendering(
        visibleCells.flatMap((cell) =>
          cell.cell_type === "code"
            ? [
                {
                  cellId: cell.id,
                  outputs: cell.outputs,
                  outputKeys: runtime.outputKeysByCell.get(cell.id),
                  retention: runtime.outputRetentionByCell.get(cell.id),
                },
              ]
            : [],
        ),
      ),
    [runtime.outputKeysByCell, runtime.outputRetentionByCell, visibleCells],
  );

  if (payload === null) {
    return (
      <div className="my-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        Notebook artifact payload is invalid.
      </div>
    );
  }
  if (bindings === null) {
    return (
      <div className="my-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        Notebook controls are unavailable outside a project-scoped authenticated session.
      </div>
    );
  }
  if (loadError !== null) {
    return (
      <div
        className="my-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm"
        role="alert"
      >
        <p className="font-medium text-destructive">Could not load notebook</p>
        <p className="mt-1 text-muted-foreground">{loadError}</p>
        <button
          type="button"
          className="mt-2 rounded border border-border px-2 py-1 text-xs"
          onClick={() => void loadRevisionAndConnect()}
        >
          Retry notebook
        </button>
      </div>
    );
  }
  if (working === null) {
    return (
      <div
        className="my-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        role="status"
      >
        Loading notebook revision…
      </div>
    );
  }

  const dirty = isNotebookWorkingCopyDirty(working);
  const disabled = pendingAction !== null || interruptPending;
  const executionDisabled =
    isNotebookExecutionDisabled(pendingAction, runtimeReady, runtime.runningCellIds) ||
    interruptPending;
  const revisionSwitchDisabled =
    isNotebookRevisionSwitchDisabled(pendingAction, runtime.runningCellIds) || interruptPending;
  const permission = bindings.agentExecutionPermission;
  const currentRevision = working.baseRevision;
  const kernelName = runtimeTarget?.kernelName ?? currentRevision.kernel.name;

  return (
    <article
      className="my-3 overflow-hidden rounded-xl border border-border bg-card"
      aria-label={`Notebook: ${artifact.title}`}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          className="rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="block text-sm font-medium">{artifact.title}</span>
          <span className="block text-[11px] text-muted-foreground">
            {working.document.metadata.kernelspec.display_name} · {working.document.cells.length}{" "}
            cells
          </span>
        </button>
        <span
          className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] capitalize text-muted-foreground"
          role="status"
        >
          Kernel {runtime.kernelStatus}
        </span>
        <span className="text-[11px] text-muted-foreground">seq {runtime.lastSequence}</span>
        <button
          type="button"
          className="rounded px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </header>

      {expanded ? (
        <div className="space-y-3 p-3">
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
            <span>Referenced {working.referencedRevision.revisionId.slice(0, 8)}</span>
            {working.latestRevision ? (
              <span>Latest {working.latestRevision.revisionId.slice(0, 8)}</span>
            ) : null}
            {dirty ? (
              <span className="font-medium text-foreground">Unsaved changes</span>
            ) : (
              <span>Saved</span>
            )}
            {working.baseRevision.revisionId !== working.referencedRevision.revisionId ? (
              <button
                type="button"
                className="rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={revisionSwitchDisabled}
                onClick={() =>
                  transitionWorkingCopy(
                    "view referenced revision",
                    viewReferencedNotebookRevision(working),
                  )
                }
              >
                View referenced revision
              </button>
            ) : null}
            {working.latestRevision &&
            working.baseRevision.revisionId !== working.latestRevision.revisionId ? (
              <button
                type="button"
                className="rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={revisionSwitchDisabled}
                onClick={() =>
                  transitionWorkingCopy("open latest revision", openLatestNotebookRevision(working))
                }
              >
                Open latest revision
              </button>
            ) : null}
          </div>

          <div
            className="flex flex-wrap items-center gap-1.5"
            role="toolbar"
            aria-label="Notebook execution controls"
          >
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
              disabled={executionDisabled}
              onClick={() =>
                void runAction("run all", async () => {
                  for (const cell of working.document.cells)
                    if (cell.cell_type === "code") await runCell(cell);
                })
              }
            >
              Run all
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
              disabled={isNotebookInterruptDisabled(
                interruptPending,
                runtimeReady,
                runtime.runningCellIds,
              )}
              onClick={() =>
                void runInterruptAction(() =>
                  bindings.controller.interrupt({
                    scope: bindings.scope,
                    sessionId,
                    onState: onRuntimeState,
                  }),
                )
              }
            >
              Interrupt
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
              disabled={executionDisabled}
              onClick={() =>
                void runAction("restart", () =>
                  bindings.controller.restart({
                    scope: bindings.scope,
                    sessionId,
                    onState: onRuntimeState,
                  }),
                )
              }
            >
              Restart kernel
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
              disabled={disabled}
              onClick={() =>
                void runAction("reconnect", async () => {
                  setRuntimeReady(false);
                  try {
                    await bindings.controller.connect({
                      scope: bindings.scope,
                      sessionId,
                      kernelName,
                      onState: onRuntimeState,
                    });
                    await bindings.controller.recover({
                      scope: bindings.scope,
                      sessionId,
                      onState: onRuntimeState,
                    });
                    if (mounted.current) setRuntimeReady(true);
                  } catch (cause) {
                    if (mounted.current) setRuntimeReady(false);
                    throw cause;
                  }
                })
              }
            >
              Reconnect
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
              disabled={disabled}
              onClick={() =>
                void runAction("dispose", async () => {
                  setRuntimeReady(false);
                  await bindings.controller.dispose({
                    scope: bindings.scope,
                    sessionId,
                    onState: onRuntimeState,
                  });
                })
              }
            >
              Dispose runtime
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
            <span className="font-medium">Agent execution</span>
            <span className="text-muted-foreground">{permission.label}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 capitalize">
              {permission.status}
            </span>
            {permission.change ? (
              <button
                type="button"
                className="rounded underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={permission.change}
              >
                Change thread permission
              </button>
            ) : null}
          </div>

          {runtime.error || actionError ? (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive"
              role="alert"
            >
              <span>{actionError ?? runtime.error}</span>
              <button
                type="button"
                className="ml-auto rounded underline"
                onClick={() => {
                  setActionError(null);
                  bindings.controller.clearError({
                    scope: bindings.scope,
                    sessionId,
                    onState: onRuntimeState,
                  });
                }}
              >
                Clear error
              </button>
            </div>
          ) : null}
          {runtime.recoveryAfterSequence !== null ? (
            <p className="text-xs text-amber-600" role="status">
              Recovering events after sequence {runtime.recoveryAfterSequence}…
            </p>
          ) : null}

          <div className="space-y-3">
            {visibleCells.map((cell) => {
              const actualIndex = working.document.cells.findIndex(
                (candidate) => candidate.id === cell.id,
              );
              const renderedOutput = outputRenderPlan.get(cell.id);
              return (
                <NotebookCell
                  key={cell.id}
                  cell={cell}
                  index={actualIndex}
                  total={working.document.cells.length}
                  disabled={disabled || runtime.runningCellIds.has(cell.id)}
                  runDisabled={executionDisabled}
                  renderedOutputs={renderedOutput?.outputs}
                  outputKeys={renderedOutput?.outputKeys}
                  outputRetention={renderedOutput?.retention}
                  onSourceChange={(source) =>
                    setWorking(updateNotebookCellSource(working, cell.id, source))
                  }
                  onRun={
                    cell.cell_type === "code" && runtimeReady
                      ? () => void runAction(`run ${cell.id}`, () => runCell(cell))
                      : undefined
                  }
                  onRunAbove={
                    cell.cell_type === "code" && runtimeReady
                      ? () =>
                          void runAction(`run above ${cell.id}`, async () => {
                            for (const previous of working.document.cells.slice(0, actualIndex))
                              if (previous.cell_type === "code") await runCell(previous);
                          })
                      : undefined
                  }
                  onMove={(direction) => setWorking(moveNotebookCell(working, cell.id, direction))}
                  onDuplicate={() =>
                    setWorking(duplicateNotebookCell(working, cell.id, () => nextId("cell")))
                  }
                  onRemove={() =>
                    setWorking(
                      removeNotebookCellFromRenderer(working, cell.id, (cellId) =>
                        bindings.controller.removeCell({
                          scope: bindings.scope,
                          sessionId,
                          cellId,
                          onState: onRuntimeState,
                        }),
                      ),
                    )
                  }
                />
              );
            })}
          </div>

          <div
            className="flex flex-wrap gap-1.5 border-t border-border pt-3"
            role="toolbar"
            aria-label="Notebook editing controls"
          >
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs"
              onClick={() =>
                setWorking(
                  addNotebookCell(working, "markdown", working.document.cells.length, () =>
                    nextId("markdown"),
                  ),
                )
              }
            >
              Add Markdown cell
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs"
              onClick={() =>
                setWorking(
                  addNotebookCell(working, "code", working.document.cells.length, () =>
                    nextId("code"),
                  ),
                )
              }
            >
              Add code cell
            </button>
            <button
              type="button"
              className="ml-auto rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
              disabled={disabled || !dirty}
              onClick={() =>
                void runAction("save", async () => {
                  const revision = await bindings.controller.saveRevision(
                    bindings.scope,
                    working.documentId,
                    working.document,
                  );
                  if (mounted.current)
                    setWorking((current) =>
                      current === null ? current : applySavedNotebookRevision(current, revision),
                    );
                })
              }
            >
              Save new revision
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
              disabled={revisionSwitchDisabled}
              onClick={() => importInput.current?.click()}
            >
              Import .ipynb
            </button>
            <input
              ref={importInput}
              className="sr-only"
              type="file"
              accept=".ipynb,application/x-ipynb+json,application/json"
              aria-label="Import notebook file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                if (
                  interruptPending ||
                  isNotebookRevisionSwitchDisabled(pendingAction, runtime.runningCellIds)
                )
                  return;
                const generation = ++lifecycleGeneration.current;
                const isActive = () =>
                  mounted.current && lifecycleGeneration.current === generation;
                void runAction("import", async () => {
                  if (isActive()) setRuntimeReady(false);
                  try {
                    const next = await importNotebookRevisionAndReplaceRuntime({
                      controller: bindings.controller,
                      scope: bindings.scope,
                      working,
                      ipynbJson: await file.text(),
                      onState: onRuntimeState,
                      isActive,
                      onWorkingCopy: (replacement) => {
                        if (!isActive()) return;
                        setRuntime(INITIAL_RUNTIME_STATE);
                        setWorking(replacement);
                      },
                    });
                    if (isActive() && next !== null) setRuntimeReady(true);
                  } catch (cause) {
                    if (!isActive()) return;
                    setRuntimeReady(false);
                    throw cause;
                  }
                });
              }}
            />
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs disabled:opacity-40"
              disabled={disabled}
              title={
                dirty ? "Export saves only immutable revisions; save changes first." : undefined
              }
              onClick={() =>
                void runAction("export", async () =>
                  bindings.controller.downloadExport(
                    await bindings.controller.exportRevision(
                      bindings.scope,
                      currentRevision.documentId,
                      currentRevision.revisionId,
                    ),
                  ),
                )
              }
            >
              Export .ipynb
            </button>
          </div>
          {pendingAction ? (
            <p className="text-xs text-muted-foreground" role="status">
              {pendingAction}…
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export default NotebookArtifactEnvelopeRenderer;

export type NotebookRenderedOutput = NotebookOutputValue;
