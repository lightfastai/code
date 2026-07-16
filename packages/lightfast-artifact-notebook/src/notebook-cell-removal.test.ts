import { describe, expect, it, vi } from "vite-plus/test";

import type { NotebookRevision } from "./contracts.ts";
import { removeNotebookCellFromRenderer } from "./notebook-cell-removal.ts";
import { addNotebookCell, createNotebookWorkingCopy } from "./working-copy.ts";

const hash = (character: string) => character.repeat(64);
const revision = (): NotebookRevision => ({
  documentId: "notebook-doc",
  revisionId: hash("a"),
  contentHash: hash("b"),
  kernel: { name: "python3", displayName: "Python 3", language: "python" },
  createdAt: "2026-07-17T00:00:00.000Z",
  document: {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
    },
    cells: [],
  },
});

describe("removeNotebookCellFromRenderer", () => {
  it("prunes runtime state for every cell removed during repeated add/remove churn", () => {
    let working = createNotebookWorkingCopy(revision());
    const pruneRuntimeCell = vi.fn();

    for (let index = 0; index < 2_000; index += 1) {
      const cellId = `code-${index}`;
      working = addNotebookCell(working, "code", 0, () => cellId);
      working = removeNotebookCellFromRenderer(working, cellId, pruneRuntimeCell);
      expect(working.document.cells.some((cell) => cell.id === cellId)).toBe(false);
    }

    expect(pruneRuntimeCell).toHaveBeenCalledTimes(2_000);
    expect(pruneRuntimeCell).toHaveBeenLastCalledWith("code-1999");
    expect(working.document.cells).toHaveLength(0);
  });
});
