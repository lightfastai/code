import type { NotebookExecutionEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyNotebookExecutionEvents,
  applyNotebookExecutionReplay,
  beginNotebookCellExecution,
  clearNotebookRuntimeError,
  createNotebookRuntimeState,
  failNotebookRuntime,
} from "./notebook.ts";

type EventInput<T = NotebookExecutionEvent> = T extends NotebookExecutionEvent
  ? Omit<T, "sessionId" | "commandId" | "sequence">
  : never;

const event = (sequence: number, value: EventInput): NotebookExecutionEvent =>
  ({
    sessionId: "session-1",
    commandId: `command-${sequence}`,
    sequence,
    ...value,
  }) as NotebookExecutionEvent;

describe("notebook runtime client state", () => {
  it("rebases a trimmed replay suffix while preserving later live gap detection", () => {
    let state = applyNotebookExecutionReplay(createNotebookRuntimeState(), {
      baselineSequence: 3,
      events: [
        event(4, {
          type: "accepted",
          commandType: "execute",
          executionId: "execution-1",
          cellId: "code-1",
        }),
        event(5, {
          type: "stream",
          executionId: "execution-1",
          name: "stdout",
          text: "replayed ",
        }),
      ],
    });

    expect(state.lastSequence).toBe(5);
    expect(state.outputsByCell.get("code-1")?.[0]).toMatchObject({ text: "replayed " });

    state = applyNotebookExecutionEvents(state, [
      event(7, {
        type: "stream",
        executionId: "execution-1",
        name: "stdout",
        text: "last",
      }),
    ]);
    expect(state.lastSequence).toBe(5);
    expect(state.recoveryAfterSequence).toBe(5);

    state = applyNotebookExecutionEvents(state, [
      event(6, {
        type: "stream",
        executionId: "execution-1",
        name: "stdout",
        text: "then ",
      }),
    ]);
    expect(state.lastSequence).toBe(7);
    expect(state.recoveryAfterSequence).toBeNull();
    expect(state.outputsByCell.get("code-1")?.[0]).toMatchObject({
      text: "replayed then last",
    });
  });

  it("reconstructs execution-to-cell identity from replayed accepted events", () => {
    const state = applyNotebookExecutionEvents(createNotebookRuntimeState(), [
      event(1, {
        type: "accepted",
        commandType: "execute",
        executionId: "execution-1",
        cellId: "code-1",
      }),
      event(2, {
        type: "stream",
        executionId: "execution-1",
        name: "stdout",
        text: "replayed\n",
      }),
    ]);

    expect(state.cellIdByExecution.get("execution-1")).toBe("code-1");
    expect(state.outputsByCell.get("code-1")).toEqual([
      { output_type: "stream", name: "stdout", text: "replayed\n" },
    ]);
    expect(state.runningCellIds.has("code-1")).toBe(true);
  });

  it("clears the corresponding running cell when execution is rejected", () => {
    const running = beginNotebookCellExecution(
      createNotebookRuntimeState(),
      "code-1",
      "execution-1",
    );
    const state = applyNotebookExecutionEvents(running, [
      event(1, {
        type: "rejected",
        executionId: "execution-1",
        reason: "command-id-conflict",
        message: "Execution was rejected.",
      }),
    ]);

    expect(state.runningCellIds.has("code-1")).toBe(false);
    expect(state.error).toBe("Execution was rejected.");
  });

  it("orders streaming events, resumes gaps, and ignores replayed sequences", () => {
    let state = createNotebookRuntimeState();
    state = applyNotebookExecutionEvents(state, [
      event(1, { type: "accepted", commandType: "open" }),
      event(2, { type: "kernel", state: "idle" }),
    ]);
    state = beginNotebookCellExecution(state, "code-1", "execution-1");
    state = applyNotebookExecutionEvents(state, [
      event(4, {
        type: "stream",
        executionId: "execution-1",
        name: "stdout",
        text: "second",
      }),
    ]);

    expect(state.lastSequence).toBe(2);
    expect(state.recoveryAfterSequence).toBe(2);

    state = applyNotebookExecutionEvents(state, [
      event(3, {
        type: "stream",
        executionId: "execution-1",
        name: "stdout",
        text: "first ",
      }),
      event(4, {
        type: "stream",
        executionId: "execution-1",
        name: "stdout",
        text: "second",
      }),
    ]);

    expect(state.lastSequence).toBe(4);
    expect(state.recoveryAfterSequence).toBeNull();
    expect(state.outputsByCell.get("code-1")).toEqual([
      { output_type: "stream", name: "stdout", text: "first second" },
    ]);
  });

  it("tracks kernel state, results, execution count, tracebacks, and limits", () => {
    let state = beginNotebookCellExecution(createNotebookRuntimeState(), "code-1", "execution-1");
    state = applyNotebookExecutionEvents(state, [
      event(1, { type: "kernel", executionId: "execution-1", state: "busy" }),
      event(2, {
        type: "result",
        executionId: "execution-1",
        executionCount: 3,
        metadata: {},
        data: { "text/plain": "3" },
      }),
      event(3, {
        type: "error",
        executionId: "execution-1",
        ename: "ValueError",
        evalue: "bad",
        traceback: ["Traceback", "ValueError: bad"],
      }),
      event(4, {
        type: "limit",
        executionId: "execution-1",
        kind: "output",
        limit: 1024,
        message: "Output was truncated.",
      }),
      event(5, { type: "kernel", executionId: "execution-1", state: "idle" }),
    ]);

    expect(state.kernelStatus).toBe("idle");
    expect(state.executionCountByCell.get("code-1")).toBe(3);
    expect(state.outputsByCell.get("code-1")?.map((output) => output.output_type)).toEqual([
      "execute_result",
      "error",
    ]);
    expect(state.error).toBe("Output was truncated.");
  });

  it("clears recoverable controller errors", () => {
    const failed = failNotebookRuntime(createNotebookRuntimeState(), "Runtime unavailable");
    expect(failed.error).toBe("Runtime unavailable");
    expect(clearNotebookRuntimeError(failed).error).toBeNull();
  });
});
