import {
  NOTEBOOK_RUNTIME_MAX_CELLS,
  applyNotebookExecutionEvents,
  createNotebookRuntimeState,
} from "@t3tools/client-runtime/state/notebook";
import type { NotebookExecutionEvent } from "@t3tools/contracts";
import { NOTEBOOK_MAX_CELLS } from "@t3tools/lightfast-artifact-notebook/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { removeNotebookCellRuntimeWithState } from "./notebookCellController.ts";

const executionEvents = (
  index: number,
  sequence: number,
): readonly [NotebookExecutionEvent, NotebookExecutionEvent] => {
  const cellId = `code-${index}`;
  const executionId = `execution-${index}`;
  return [
    {
      type: "accepted",
      sessionId: "session-1",
      commandId: `command-${index}`,
      sequence,
      commandType: "execute",
      executionId,
      cellId,
    },
    {
      type: "kernel",
      sessionId: "session-1",
      commandId: `command-${index}`,
      sequence: sequence + 1,
      executionId,
      cellId,
      state: "idle",
    },
  ];
};

describe("removeNotebookCellRuntimeWithState", () => {
  it("keeps the runtime-cell cap aligned with the document cell limit", () => {
    expect(NOTEBOOK_RUNTIME_MAX_CELLS).toBe(NOTEBOOK_MAX_CELLS);
  });

  it("prunes every unique cell across repeated execute-remove-add churn", () => {
    let state = createNotebookRuntimeState();
    const publish = vi.fn((next: typeof state) => {
      state = next;
    });
    for (let index = 0; index < 2_000; index += 1) {
      const cellId = `code-${index}`;
      state = applyNotebookExecutionEvents(state, executionEvents(index, index * 2 + 1));

      removeNotebookCellRuntimeWithState({
        cellId,
        current: () => state,
        publish,
      });

      expect(state.latestExecutionIdByCell.has(cellId)).toBe(false);
      expect(state.outputsByCell.has(cellId)).toBe(false);
      expect(state.outputCellRecency).not.toContain(cellId);
      expect(state.runtimeCellRecency).not.toContain(cellId);
    }

    expect(publish).toHaveBeenCalledTimes(2_000);
    expect(state.latestExecutionIdByCell.size).toBe(0);
    expect(state.outputsByCell.size).toBe(0);
    expect(state.runtimeCellRecency).toHaveLength(0);
  });
});
