import {
  applyNotebookExecutionEvents,
  applyNotebookExecutionReplay,
  createNotebookRuntimeState,
} from "@t3tools/client-runtime/state/notebook";
import type { NotebookExecutionEvent } from "@t3tools/contracts";
import { isNotebookRevisionSwitchDisabled } from "@t3tools/lightfast-artifact-notebook/web";
import { describe, expect, it, vi } from "vite-plus/test";

import { executeNotebookCellWithState } from "./notebookExecutionController.ts";

describe("executeNotebookCellWithState", () => {
  it("does not queue another execution while any notebook cell is running", async () => {
    let state = applyNotebookExecutionReplay(createNotebookRuntimeState(), {
      baselineSequence: 5,
      events: [
        {
          type: "stream",
          sessionId: "session-1",
          commandId: "command-active",
          executionId: "execution-active",
          cellId: "code-active",
          sequence: 6,
          name: "stdout",
          text: "still running\n",
        },
      ],
    });
    const publish = vi.fn((next: typeof state) => {
      state = next;
    });
    const execute = vi.fn(async () => undefined);

    await executeNotebookCellWithState({
      cellId: "code-queued",
      executionId: "execution-queued",
      current: () => state,
      publish,
      execute,
      recover: vi.fn(async () => undefined),
    });

    expect(execute).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(state.runningCellIds).toEqual(new Set(["code-active"]));
  });

  it("rolls back an optimistic cell when the RPC rejects before emitting events", async () => {
    let state = createNotebookRuntimeState();
    const published = vi.fn((next: typeof state) => {
      state = next;
    });
    const failure = new Error("RPC rejected before streaming.");

    await expect(
      executeNotebookCellWithState({
        cellId: "code-rpc",
        executionId: "execution-rpc",
        current: () => state,
        publish: published,
        execute: async () => {
          throw failure;
        },
        recover: vi.fn(async () => undefined),
      }),
    ).rejects.toBe(failure);

    expect(published).toHaveBeenCalledTimes(2);
    expect(state.runningCellIds.has("code-rpc")).toBe(false);
    expect(state.activeExecutionIdByCell.has("code-rpc")).toBe(false);
    expect(state.error).toBe("RPC rejected before streaming.");
  });

  it("disables revision controls for a mid-execution suffix and re-enables them on finish", () => {
    let state = applyNotebookExecutionReplay(createNotebookRuntimeState(), {
      baselineSequence: 5,
      events: [
        {
          type: "stream",
          sessionId: "session-1",
          commandId: "command-1",
          executionId: "execution-1",
          cellId: "code-1",
          sequence: 6,
          name: "stdout",
          text: "running\n",
        },
      ],
    });

    expect(isNotebookRevisionSwitchDisabled(null, state.runningCellIds)).toBe(true);

    state = applyNotebookExecutionEvents(state, [
      {
        type: "kernel",
        sessionId: "session-1",
        commandId: "command-1",
        executionId: "execution-1",
        cellId: "code-1",
        sequence: 7,
        state: "idle",
      } satisfies NotebookExecutionEvent,
    ]);
    expect(isNotebookRevisionSwitchDisabled(null, state.runningCellIds)).toBe(false);
  });
});
