import { removeNotebookCell, type NotebookWorkingCopy } from "./working-copy.ts";

export function removeNotebookCellFromRenderer(
  working: NotebookWorkingCopy,
  cellId: string,
  pruneRuntimeCell: (cellId: string) => void,
): NotebookWorkingCopy {
  const next = removeNotebookCell(working, cellId);
  if (next === working) return working;
  pruneRuntimeCell(cellId);
  return next;
}
