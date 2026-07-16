import {
  applyNotebookExecutionEvents,
  beginNotebookCellExecution,
  failNotebookCellExecution,
  failNotebookRuntime,
  type NotebookRuntimeState,
} from "@t3tools/client-runtime/state/notebook";
import type { NotebookExecutionEvent } from "@t3tools/contracts";

export type ExecuteNotebookCellWithStateOptions = {
  readonly cellId: string;
  readonly executionId: string;
  readonly current: () => NotebookRuntimeState;
  readonly publish: (state: NotebookRuntimeState) => void;
  readonly execute: (onEvent: (event: NotebookExecutionEvent) => void) => Promise<void>;
  readonly recover: () => Promise<void>;
};

export const notebookExecutionFailureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export async function executeNotebookCellWithState(
  options: ExecuteNotebookCellWithStateOptions,
): Promise<void> {
  options.publish(
    beginNotebookCellExecution(options.current(), options.cellId, options.executionId),
  );
  let receivedEvent = false;
  try {
    await options.execute((event) => {
      receivedEvent = true;
      options.publish(applyNotebookExecutionEvents(options.current(), [event]));
    });
    if (options.current().recoveryAfterSequence !== null) await options.recover();
  } catch (cause) {
    const message = notebookExecutionFailureMessage(cause);
    options.publish(
      receivedEvent
        ? failNotebookRuntime(options.current(), message)
        : failNotebookCellExecution(
            options.current(),
            options.cellId,
            options.executionId,
            message,
          ),
    );
    throw cause;
  }
}
