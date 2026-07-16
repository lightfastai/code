import { describe, expect, it, vi } from "vite-plus/test";

import type { NotebookRevision } from "./contracts.ts";
import {
  importNotebookRevisionAndReplaceRuntime,
  loadNotebookRevisionAndConnect,
  notebookRuntimeTarget,
} from "./runtime-lifecycle.ts";
import { createNotebookWorkingCopy } from "./working-copy.ts";
import type { NotebookArtifactController, NotebookProjectScope } from "./web.tsx";

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
    interrupt: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
    clearError: vi.fn(),
    ...overrides,
  }) as NotebookArtifactController;

describe("notebook runtime lifecycle", () => {
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
    expect(connect).toHaveBeenCalledWith({
      scope,
      sessionId: "notebook-original-doc",
      kernelName: "python3",
      onState,
    });
  });

  it("disposes the previous runtime and connects using imported document identity", async () => {
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

    const next = await importNotebookRevisionAndReplaceRuntime({
      controller: bindings,
      scope,
      working: createNotebookWorkingCopy(original),
      ipynbJson: "{}",
      onState,
      onWorkingCopy: (working) => order.push(`working:${working.documentId}`),
    });

    expect(next).not.toBeNull();
    if (next === null) throw new Error("Expected imported notebook working copy.");
    expect(notebookRuntimeTarget(next)).toEqual({
      sessionId: "notebook-imported-doc",
      kernelName: "julia-1.11",
    });
    expect(order).toEqual([
      "dispose:notebook-original-doc",
      "working:imported-doc",
      "connect:notebook-imported-doc:julia-1.11",
    ]);
  });
});
