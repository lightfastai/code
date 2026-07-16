import { describe, expect, it } from "vite-plus/test";

import type { NotebookRevision } from "./contracts.ts";
import {
  addNotebookCell,
  applySavedNotebookRevision,
  createNotebookWorkingCopy,
  duplicateNotebookCell,
  isNotebookWorkingCopyDirty,
  moveNotebookCell,
  openLatestNotebookRevision,
  removeNotebookCell,
  updateNotebookCellSource,
  viewReferencedNotebookRevision,
} from "./working-copy.ts";

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
    cells: [
      { cell_type: "markdown", id: "intro", metadata: {}, source: "# Intro" },
      {
        cell_type: "code",
        id: "code-1",
        metadata: {},
        source: "print(1)",
        execution_count: null,
        outputs: [],
      },
    ],
  },
});

describe("notebook working copy", () => {
  it("edits a copy while preserving the chat-referenced revision", () => {
    const referenced = revision();
    const state = createNotebookWorkingCopy(referenced);
    const edited = updateNotebookCellSource(state, "code-1", "print(2)");

    expect(edited.document.cells[1]?.source).toBe("print(2)");
    expect(referenced.document.cells[1]?.source).toBe("print(1)");
    expect(edited.referencedRevision).toBe(referenced);
    expect(isNotebookWorkingCopyDirty(edited)).toBe(true);
  });

  it("adds, duplicates, reorders, and removes cells with stable unique IDs", () => {
    let nextId = 0;
    const idFactory = () => `new-cell-${++nextId}`;
    const initial = createNotebookWorkingCopy(revision());
    const added = addNotebookCell(initial, "code", 1, idFactory);
    const duplicated = duplicateNotebookCell(added, "intro", idFactory);
    const moved = moveNotebookCell(duplicated, "new-cell-2", 1);
    const removed = removeNotebookCell(moved, "code-1");
    const ids = removed.document.cells.map((cell) => cell.id);

    expect(ids).toEqual(["intro", "new-cell-1", "new-cell-2"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(removed.document.cells.find((cell) => cell.id === "new-cell-2")?.source).toBe("# Intro");
  });

  it("keeps referenced and latest revisions distinct after immutable save", () => {
    const original = revision();
    const edited = updateNotebookCellSource(
      createNotebookWorkingCopy(original),
      "code-1",
      "print('saved')",
    );
    const savedRevision: NotebookRevision = {
      ...original,
      revisionId: hash("c"),
      contentHash: hash("d"),
      document: edited.document,
      createdAt: "2026-07-17T00:01:00.000Z",
    };
    const saved = applySavedNotebookRevision(edited, savedRevision);

    expect(saved.referencedRevision.revisionId).toBe(hash("a"));
    expect(saved.latestRevision?.revisionId).toBe(hash("c"));
    expect(saved.baseRevision.revisionId).toBe(hash("c"));
    expect(isNotebookWorkingCopyDirty(saved)).toBe(false);

    const referencedView = viewReferencedNotebookRevision(saved);
    expect(referencedView.documentId).toBe(original.documentId);
    expect(referencedView.document.cells[1]?.source).toBe("print(1)");
    expect(referencedView.latestRevision?.revisionId).toBe(hash("c"));

    const latestView = openLatestNotebookRevision(referencedView);
    expect(latestView.documentId).toBe(savedRevision.documentId);
    expect(latestView.document.cells[1]?.source).toBe("print('saved')");
  });
});
