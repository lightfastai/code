import type {
  NotebookCell,
  NotebookDocument,
  NotebookOutput,
  NotebookRevision,
} from "./contracts.ts";

export interface NotebookWorkingCopy {
  readonly referencedRevision: NotebookRevision;
  readonly latestRevision: NotebookRevision | null;
  readonly baseRevision: NotebookRevision;
  readonly documentId: string;
  readonly document: NotebookDocument;
}

export type NotebookCellIdFactory = () => string;

const cloneDocument = (document: NotebookDocument): NotebookDocument => structuredClone(document);

const replaceCells = (
  state: NotebookWorkingCopy,
  cells: ReadonlyArray<NotebookCell>,
): NotebookWorkingCopy => ({
  ...state,
  document: { ...state.document, cells },
});

const uniqueCellId = (state: NotebookWorkingCopy, idFactory: NotebookCellIdFactory): string => {
  const existing = new Set(state.document.cells.map((cell) => cell.id));
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const raw = idFactory()
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .slice(0, 64);
    if (raw.length > 0 && !existing.has(raw)) return raw;
  }
  throw new Error("Could not allocate a unique notebook cell ID.");
};

export function createNotebookWorkingCopy(
  referencedRevision: NotebookRevision,
): NotebookWorkingCopy {
  return {
    referencedRevision,
    latestRevision: null,
    baseRevision: referencedRevision,
    documentId: referencedRevision.documentId,
    document: cloneDocument(referencedRevision.document),
  };
}

export function isNotebookWorkingCopyDirty(state: NotebookWorkingCopy): boolean {
  return JSON.stringify(state.document) !== JSON.stringify(state.baseRevision.document);
}

export function updateNotebookCellSource(
  state: NotebookWorkingCopy,
  cellId: string,
  source: string,
): NotebookWorkingCopy {
  return replaceCells(
    state,
    state.document.cells.map((cell) => (cell.id === cellId ? { ...cell, source } : cell)),
  );
}

export function updateNotebookCodeCellExecution(
  state: NotebookWorkingCopy,
  cellId: string,
  executionCount: number | null,
  outputs: ReadonlyArray<NotebookOutput>,
): NotebookWorkingCopy {
  return replaceCells(
    state,
    state.document.cells.map((cell) =>
      cell.id === cellId && cell.cell_type === "code"
        ? { ...cell, execution_count: executionCount, outputs }
        : cell,
    ),
  );
}

export function addNotebookCell(
  state: NotebookWorkingCopy,
  type: "markdown" | "code",
  index: number,
  idFactory: NotebookCellIdFactory,
): NotebookWorkingCopy {
  const id = uniqueCellId(state, idFactory);
  const cell: NotebookCell =
    type === "markdown"
      ? { cell_type: "markdown", id, metadata: {}, source: "" }
      : {
          cell_type: "code",
          id,
          metadata: {},
          source: "",
          execution_count: null,
          outputs: [],
        };
  const cells = [...state.document.cells];
  cells.splice(Math.max(0, Math.min(index, cells.length)), 0, cell);
  return replaceCells(state, cells);
}

export function duplicateNotebookCell(
  state: NotebookWorkingCopy,
  cellId: string,
  idFactory: NotebookCellIdFactory,
): NotebookWorkingCopy {
  const index = state.document.cells.findIndex((cell) => cell.id === cellId);
  if (index < 0) return state;
  const source = state.document.cells[index];
  if (source === undefined) return state;
  const duplicate = structuredClone(source) as NotebookCell;
  const cell = { ...duplicate, id: uniqueCellId(state, idFactory) } as NotebookCell;
  const cells = [...state.document.cells];
  cells.splice(index + 1, 0, cell);
  return replaceCells(state, cells);
}

export function moveNotebookCell(
  state: NotebookWorkingCopy,
  cellId: string,
  direction: -1 | 1,
): NotebookWorkingCopy {
  const index = state.document.cells.findIndex((cell) => cell.id === cellId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= state.document.cells.length) return state;
  const cells = [...state.document.cells];
  const [cell] = cells.splice(index, 1);
  if (cell === undefined) return state;
  cells.splice(target, 0, cell);
  return replaceCells(state, cells);
}

export function removeNotebookCell(
  state: NotebookWorkingCopy,
  cellId: string,
): NotebookWorkingCopy {
  const cells = state.document.cells.filter((cell) => cell.id !== cellId);
  return cells.length === state.document.cells.length ? state : replaceCells(state, cells);
}

export function applySavedNotebookRevision(
  state: NotebookWorkingCopy,
  revision: NotebookRevision,
): NotebookWorkingCopy {
  return {
    ...state,
    latestRevision: revision,
    baseRevision: revision,
    documentId: revision.documentId,
    document: cloneDocument(revision.document),
  };
}

export function applyImportedNotebookRevision(
  state: NotebookWorkingCopy,
  revision: NotebookRevision,
): NotebookWorkingCopy {
  return applySavedNotebookRevision(state, revision);
}

export function viewReferencedNotebookRevision(state: NotebookWorkingCopy): NotebookWorkingCopy {
  return {
    ...state,
    baseRevision: state.referencedRevision,
    documentId: state.referencedRevision.documentId,
    document: cloneDocument(state.referencedRevision.document),
  };
}

export function openLatestNotebookRevision(state: NotebookWorkingCopy): NotebookWorkingCopy {
  const latest = state.latestRevision;
  if (latest === null) return state;
  return {
    ...state,
    baseRevision: latest,
    documentId: latest.documentId,
    document: cloneDocument(latest.document),
  };
}
