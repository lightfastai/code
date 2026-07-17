import { describe, expect, it, vi } from "vite-plus/test";

import type { NotebookRevision } from "./contracts.ts";
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
import {
  applyImportedNotebookRevision,
  applyNotebookRuntimeToWorkingCopy,
  applySavedNotebookRevision,
  createNotebookWorkingCopy,
  isNotebookWorkingCopyDirty,
  openLatestNotebookRevision,
  viewReferencedNotebookRevision,
} from "./working-copy.ts";
import type {
  NotebookArtifactController,
  NotebookProjectScope,
  NotebookRuntimeView,
} from "./web.tsx";

const hash = (character: string) => character.repeat(64);
const revision = (
  documentId: string,
  kernel: { readonly name: string; readonly displayName: string; readonly language: string },
): NotebookRevision => ({
  documentId,
  revisionId: hash(documentId === "original-doc" ? "a" : "b"),
  contentHash: hash(documentId === "original-doc" ? "c" : "d"),
  kernel,
  createdAt: "2026-07-17T00:00:00.000Z",
  document: {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        name: kernel.name,
        display_name: kernel.displayName,
        language: kernel.language,
      },
    },
    cells: [],
  },
});

const scope: NotebookProjectScope = { environmentId: "environment-1", projectId: "project-1" };
const onState = vi.fn();

const deferred = () => {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve } as const;
};

const controller = (overrides: Partial<NotebookArtifactController>): NotebookArtifactController =>
  ({
    readRevision: vi.fn(),
    saveRevision: vi.fn(),
    importRevision: vi.fn(),
    exportRevision: vi.fn(),
    downloadExport: vi.fn(),
    connect: vi.fn(),
    recover: vi.fn(),
    executeCell: vi.fn(),
    removeCell: vi.fn(),
    interrupt: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  }) as NotebookArtifactController;

describe("notebook runtime lifecycle", () => {
  it("gives immutable revisions of one document distinct bounded runtime identities", () => {
    const first = revision("same-doc", {
      name: "python3",
      displayName: "Python 3",
      language: "python",
    });
    const second: NotebookRevision = {
      ...first,
      revisionId: hash("e"),
      contentHash: hash("f"),
    };

    const firstTarget = notebookRuntimeTarget(createNotebookWorkingCopy(first));
    const secondTarget = notebookRuntimeTarget(createNotebookWorkingCopy(second));

    expect(firstTarget.sessionId).not.toBe(secondTarget.sessionId);
    expect(firstTarget.revisionId).toBe(first.revisionId);
    expect(secondTarget.revisionId).toBe(second.revisionId);
    expect(firstTarget.sessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(secondTarget.sessionId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(firstTarget.sessionId.length).toBeLessThanOrEqual(128);
    expect(secondTarget.sessionId.length).toBeLessThanOrEqual(128);
  });

  it("retries the shared revision-load-and-connect flow and clears the load error", async () => {
    const loaded = revision("original-doc", {
      name: "python3",
      displayName: "Python 3",
      language: "python",
    });
    const readRevision = vi
      .fn<NotebookArtifactController["readRevision"]>()
      .mockRejectedValueOnce(new Error("revision unavailable"))
      .mockResolvedValueOnce(loaded);
    const connect = vi.fn<NotebookArtifactController["connect"]>().mockResolvedValue();
    const errors: Array<string | null> = [];
    const workingCopies: string[] = [];
    const bindings = controller({ readRevision, connect });
    const request = {
      controller: bindings,
      scope,
      documentId: "original-doc",
      revisionId: hash("a"),
      onState,
      onLoadError: (error: string | null) => errors.push(error),
      onWorkingCopy: (working: { readonly documentId: string }) =>
        workingCopies.push(working.documentId),
    };

    await expect(loadNotebookRevisionAndConnect(request)).rejects.toThrow("revision unavailable");
    await expect(loadNotebookRevisionAndConnect(request)).resolves.toMatchObject({
      documentId: "original-doc",
    });

    expect(readRevision).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([null, "revision unavailable", null]);
    expect(workingCopies).toEqual(["original-doc"]);
    const target = notebookRuntimeTarget(createNotebookWorkingCopy(loaded));
    expect(connect).toHaveBeenCalledWith({
      scope,
      ...target,
      kernelName: "python3",
      onState: expect.any(Function),
    });
  });

  it("transitions import to referenced revision and back to latest through matching runtimes", async () => {
    const original = revision("original-doc", {
      name: "python3",
      displayName: "Python 3",
      language: "python",
    });
    const imported = revision("imported-doc", {
      name: "julia-1.11",
      displayName: "Julia 1.11",
      language: "julia",
    });
    const originalTarget = notebookRuntimeTarget(createNotebookWorkingCopy(original));
    const importedTarget = notebookRuntimeTarget(createNotebookWorkingCopy(imported));
    const order: string[] = [];
    const bindings = controller({
      importRevision: vi.fn(async () => imported),
      dispose: vi.fn(async (request) => {
        order.push(`dispose:${request.sessionId}`);
      }),
      connect: vi.fn(async (request) => {
        order.push(`connect:${request.sessionId}:${request.kernelName}`);
      }),
    });

    let current = createNotebookWorkingCopy(original);
    const importedWorking = await importNotebookRevisionAndReplaceRuntime({
      controller: bindings,
      scope,
      working: current,
      ipynbJson: "{}",
      onState,
      onWorkingCopy: (working) => {
        current = working;
        order.push(`working:${working.documentId}`);
      },
    });

    expect(importedWorking).not.toBeNull();
    if (importedWorking === null) throw new Error("Expected imported notebook working copy.");
    await replaceNotebookWorkingCopyRuntime({
      controller: bindings,
      scope,
      working: current,
      nextWorking: viewReferencedNotebookRevision(current),
      onState,
      onWorkingCopy: (working) => {
        current = working;
        order.push(`working:${working.documentId}`);
      },
    });
    await replaceNotebookWorkingCopyRuntime({
      controller: bindings,
      scope,
      working: current,
      nextWorking: openLatestNotebookRevision(current),
      onState,
      onWorkingCopy: (working) => {
        current = working;
        order.push(`working:${working.documentId}`);
      },
    });

    expect(notebookRuntimeTarget(current)).toEqual(importedTarget);
    expect(order).toEqual([
      `dispose:${originalTarget.sessionId}`,
      "working:imported-doc",
      `connect:${importedTarget.sessionId}:julia-1.11`,
      `dispose:${importedTarget.sessionId}`,
      "working:original-doc",
      `connect:${originalTarget.sessionId}:python3`,
      `dispose:${originalTarget.sessionId}`,
      "working:imported-doc",
      `connect:${importedTarget.sessionId}:julia-1.11`,
    ]);
  });

  it("disposes a same-document runtime before connecting a different immutable revision", async () => {
    const referenced: NotebookRevision = {
      ...revision("same-doc", {
        name: "python3",
        displayName: "Python 3",
        language: "python",
      }),
      document: {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
        },
        cells: [
          {
            cell_type: "code",
            id: "code-1",
            metadata: {},
            source: "print('referenced')",
            execution_count: null,
            outputs: [],
          },
        ],
      },
    };
    const latest: NotebookRevision = {
      ...referenced,
      revisionId: hash("e"),
      contentHash: hash("f"),
      createdAt: "2026-07-17T00:01:00.000Z",
    };
    const staleOutputs = [
      { output_type: "stream" as const, name: "stdout" as const, text: "latest output\n" },
    ];
    let retainedOutputs = new Map([["code-1", staleOutputs]]);
    let retainedExecutionCounts = new Map([["code-1", 1]]);
    let current = applySavedNotebookRevision(createNotebookWorkingCopy(referenced), latest);
    const nextWorking = viewReferencedNotebookRevision(current);
    const previousTarget = notebookRuntimeTarget(current);
    const nextTarget = notebookRuntimeTarget(nextWorking);
    const order: string[] = [];
    const bindings = controller({
      dispose: vi.fn(async (request) => {
        order.push(`dispose:${request.sessionId}`);
        retainedOutputs = new Map();
        retainedExecutionCounts = new Map();
      }),
      connect: vi.fn(async (request) => {
        order.push(`connect:${request.sessionId}:${request.kernelName}`);
        request.onState({
          kernelStatus: "idle",
          lastSequence: 1,
          recoveryAfterSequence: null,
          outputsByCell: retainedOutputs,
          outputKeysByCell: new Map(),
          outputRetentionByCell: new Map(),
          executionCountByCell: retainedExecutionCounts,
          runningCellIds: new Set(),
          error: null,
        });
      }),
    });

    await replaceNotebookWorkingCopyRuntime({
      controller: bindings,
      scope,
      working: current,
      nextWorking,
      onState: (state) => {
        order.push(`runtime:${state.outputsByCell.size}`);
        current = applyNotebookRuntimeToWorkingCopy(current, state);
      },
      onWorkingCopy: (working) => {
        order.push(`working:${working.baseRevision.revisionId.slice(0, 8)}`);
        current = working;
      },
    });

    expect(order).toEqual([
      `dispose:${previousTarget.sessionId}`,
      `working:${referenced.revisionId.slice(0, 8)}`,
      `connect:${nextTarget.sessionId}:python3`,
      "runtime:0",
    ]);
    expect(current.document.cells[0]).toMatchObject({ execution_count: null, outputs: [] });
    expect(isNotebookWorkingCopyDirty(current)).toBe(false);
  });

  it("reconnects the same unchanged revision without disposing its session", async () => {
    const current = createNotebookWorkingCopy(
      revision("same-doc", {
        name: "python3",
        displayName: "Python 3",
        language: "python",
      }),
    );
    const order: string[] = [];
    const target = notebookRuntimeTarget(current);
    const bindings = controller({
      dispose: vi.fn(async () => {
        order.push("dispose");
      }),
      connect: vi.fn(async (request) => {
        order.push(`connect:${request.sessionId}:${request.kernelName}`);
      }),
    });

    await replaceNotebookWorkingCopyRuntime({
      controller: bindings,
      scope,
      working: current,
      nextWorking: current,
      onState,
      onWorkingCopy: () => order.push("working"),
    });

    expect(order).toEqual(["working", `connect:${target.sessionId}:python3`]);
    expect(bindings.dispose).not.toHaveBeenCalled();
  });

  it("blocks revision switches during an action or cell execution", () => {
    expect(isNotebookRevisionSwitchDisabled(null, new Set())).toBe(false);
    expect(isNotebookRevisionSwitchDisabled("import", new Set())).toBe(true);
    expect(isNotebookRevisionSwitchDisabled(null, new Set(["code-1"]))).toBe(true);
  });

  it("globally blocks notebook execution while any cell is running", () => {
    expect(isNotebookExecutionDisabled(null, true, new Set())).toBe(false);
    expect(isNotebookExecutionDisabled("run all", true, new Set())).toBe(true);
    expect(isNotebookExecutionDisabled(null, false, new Set())).toBe(true);
    expect(isNotebookExecutionDisabled(null, true, new Set(["code-other"]))).toBe(true);
  });

  it("enables interrupt only for a ready runtime with a running cell and no pending request", () => {
    expect(isNotebookInterruptDisabled(false, true, new Set())).toBe(true);
    expect(isNotebookInterruptDisabled(false, true, new Set(["code-1"]))).toBe(false);
    expect(isNotebookInterruptDisabled(true, true, new Set(["code-1"]))).toBe(true);
    expect(isNotebookInterruptDisabled(false, false, new Set(["code-1"]))).toBe(true);
  });

  it.each(["completion", "failure"] as const)(
    "does not let execution %s clear an overlapping pending interrupt",
    async (outcome) => {
      const executionDeferred = deferred();
      const interruptDeferred = deferred();
      let executionPending = false;
      let interruptPending = false;
      const errors: Array<string | null> = [];
      const execution = runNotebookTrackedAction({
        action: () => executionDeferred.promise,
        onError: (error) => errors.push(error),
        onPendingChange: (pending) => {
          executionPending = pending;
        },
      });
      const interrupt = runNotebookTrackedAction({
        action: () => interruptDeferred.promise,
        onError: (error) => errors.push(error),
        onPendingChange: (pending) => {
          interruptPending = pending;
        },
      });

      expect(executionPending).toBe(true);
      expect(interruptPending).toBe(true);
      if (outcome === "completion") executionDeferred.resolve();
      else executionDeferred.reject(new Error("execution failed"));
      await execution;

      expect(executionPending).toBe(false);
      expect(interruptPending).toBe(true);
      interruptDeferred.resolve();
      await interrupt;
      expect(interruptPending).toBe(false);
      expect(errors).toEqual(
        outcome === "completion" ? [null, null] : [null, null, "execution failed"],
      );
    },
  );

  it("continues import after an explicitly disposed old runtime is already absent", async () => {
    const original = revision("original-doc", {
      name: "python3",
      displayName: "Python 3",
      language: "python",
    });
    const imported = revision("imported-doc", {
      name: "julia-1.11",
      displayName: "Julia 1.11",
      language: "julia",
    });
    const importedTarget = notebookRuntimeTarget(createNotebookWorkingCopy(imported));
    const workingCopies: string[] = [];
    const bindings = controller({
      importRevision: vi.fn(async () => imported),
      dispose: vi.fn(async () => {
        throw { reason: "session-not-found", message: "Already disposed." };
      }),
      connect: vi.fn(async () => undefined),
    });

    await expect(
      importNotebookRevisionAndReplaceRuntime({
        controller: bindings,
        scope,
        working: createNotebookWorkingCopy(original),
        ipynbJson: "{}",
        onState,
        onWorkingCopy: (working) => workingCopies.push(working.documentId),
      }),
    ).resolves.toMatchObject({ documentId: "imported-doc" });

    expect(workingCopies).toEqual(["imported-doc"]);
    expect(bindings.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: importedTarget.sessionId,
        revisionId: importedTarget.revisionId,
        kernelName: "julia-1.11",
      }),
    );
  });

  it("continues revision switching after an explicitly disposed old runtime is already absent", async () => {
    const original = revision("original-doc", {
      name: "python3",
      displayName: "Python 3",
      language: "python",
    });
    const imported = revision("imported-doc", {
      name: "julia-1.11",
      displayName: "Julia 1.11",
      language: "julia",
    });
    const current = applyImportedNotebookRevision(createNotebookWorkingCopy(original), imported);
    const originalTarget = notebookRuntimeTarget(createNotebookWorkingCopy(original));
    const workingCopies: string[] = [];
    const bindings = controller({
      dispose: vi.fn(async () => {
        throw { reason: "session-not-found", message: "Already disposed." };
      }),
      connect: vi.fn(async () => undefined),
    });

    await expect(
      replaceNotebookWorkingCopyRuntime({
        controller: bindings,
        scope,
        working: current,
        nextWorking: viewReferencedNotebookRevision(current),
        onState,
        onWorkingCopy: (working) => workingCopies.push(working.documentId),
      }),
    ).resolves.toMatchObject({ documentId: "original-doc" });

    expect(workingCopies).toEqual(["original-doc"]);
    expect(bindings.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: originalTarget.sessionId,
        revisionId: originalTarget.revisionId,
        kernelName: "python3",
      }),
    );
  });

  it("aborts revision switching for disposal failures other than session-not-found", async () => {
    const original = revision("original-doc", {
      name: "python3",
      displayName: "Python 3",
      language: "python",
    });
    const imported = revision("imported-doc", {
      name: "julia-1.11",
      displayName: "Julia 1.11",
      language: "julia",
    });
    const current = applyImportedNotebookRevision(createNotebookWorkingCopy(original), imported);
    const workingCopies: string[] = [];
    const failure = { reason: "runtime-unavailable", message: "Sidecar unavailable." };
    const bindings = controller({
      dispose: vi.fn(async () => {
        throw failure;
      }),
      connect: vi.fn(async () => undefined),
    });

    await expect(
      replaceNotebookWorkingCopyRuntime({
        controller: bindings,
        scope,
        working: current,
        nextWorking: viewReferencedNotebookRevision(current),
        onState,
        onWorkingCopy: (working) => workingCopies.push(working.documentId),
      }),
    ).rejects.toBe(failure);

    expect(workingCopies).toEqual([]);
    expect(bindings.connect).not.toHaveBeenCalled();
  });

  it("drops stale runtime callbacks after a load generation is invalidated", async () => {
    const loaded = revision("original-doc", {
      name: "python3",
      displayName: "Python 3",
      language: "python",
    });
    let active = true;
    let connectedRequest: Parameters<NotebookArtifactController["connect"]>[0] | undefined;
    let releaseConnect!: () => void;
    const connectReleased = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const states: NotebookRuntimeView[] = [];
    const bindings = controller({
      readRevision: vi.fn(async () => loaded),
      connect: vi.fn(async (request) => {
        connectedRequest = request;
        await connectReleased;
      }),
    });
    const loading = loadNotebookRevisionAndConnect({
      controller: bindings,
      scope,
      documentId: loaded.documentId,
      revisionId: loaded.revisionId,
      onState: (state) => states.push(state),
      onLoadError: vi.fn(),
      onWorkingCopy: vi.fn(),
      isActive: () => active,
    });

    await vi.waitFor(() => expect(connectedRequest).toBeDefined());
    active = false;
    connectedRequest?.onState({
      kernelStatus: "idle",
      lastSequence: 10,
      recoveryAfterSequence: null,
      outputsByCell: new Map(),
      outputKeysByCell: new Map(),
      outputRetentionByCell: new Map(),
      executionCountByCell: new Map(),
      runningCellIds: new Set(),
      error: null,
    });
    releaseConnect();
    await loading;

    expect(states).toEqual([]);
  });
});
