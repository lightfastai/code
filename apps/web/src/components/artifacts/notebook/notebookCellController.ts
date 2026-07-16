import {
  pruneNotebookRuntimeCell,
  type NotebookRuntimeState,
} from "@t3tools/client-runtime/state/notebook";

export type RemoveNotebookCellRuntimeWithStateOptions = {
  readonly cellId: string;
  readonly current: () => NotebookRuntimeState;
  readonly publish: (state: NotebookRuntimeState) => void;
};

export function removeNotebookCellRuntimeWithState(
  options: RemoveNotebookCellRuntimeWithStateOptions,
): void {
  options.publish(pruneNotebookRuntimeCell(options.current(), options.cellId));
}
