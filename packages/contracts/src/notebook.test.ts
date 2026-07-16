import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  NotebookCellExecuteInput,
  NotebookExecutionEvent,
  NotebookExecutionReplay,
} from "./notebook.ts";

const decodeExecuteInput = Schema.decodeUnknownSync(NotebookCellExecuteInput);
const decodeExecutionEvent = Schema.decodeUnknownSync(NotebookExecutionEvent);
const decodeExecutionReplay = Schema.decodeUnknownSync(NotebookExecutionReplay);

describe("notebook execution contracts", () => {
  it("requires a cell ID on execute requests and accepted execute events", () => {
    const executeInput = {
      scope: { environmentId: "environment-1", projectId: "project-1" },
      sessionId: "session-1",
      commandId: "command-1",
      executionId: "execution-1",
      cellId: "cell-1",
      code: "print('hello')",
    };
    const acceptedEvent = {
      type: "accepted",
      sessionId: "session-1",
      commandId: "command-1",
      executionId: "execution-1",
      cellId: "cell-1",
      sequence: 1,
      commandType: "execute",
    };

    expect(decodeExecuteInput(executeInput)).toMatchObject({
      cellId: "cell-1",
    });
    expect(decodeExecutionEvent(acceptedEvent)).toMatchObject({
      cellId: "cell-1",
    });
    expect(() => {
      const { cellId: _, ...missingCellId } = executeInput;
      decodeExecuteInput(missingCellId);
    }).toThrow();
    expect(() => {
      const { cellId: _, ...missingCellId } = acceptedEvent;
      decodeExecutionEvent(missingCellId);
    }).toThrow();
  });

  it("requires cell identity on every execution-scoped event", () => {
    const base = {
      sessionId: "session-1",
      commandId: "command-1",
      executionId: "execution-1",
      cellId: "cell-1",
      sequence: 1,
    };
    const executionEvents = [
      { ...base, type: "stream", name: "stdout", text: "hello" },
      { ...base, type: "display", data: { "text/plain": "hello" }, metadata: {} },
      {
        ...base,
        type: "result",
        data: { "text/plain": "hello" },
        metadata: {},
        executionCount: 1,
      },
      { ...base, type: "error", ename: "Error", evalue: "bad", traceback: [] },
      { ...base, type: "limit", kind: "output", limit: 1, message: "limited" },
      { ...base, type: "kernel", state: "idle" },
      { ...base, type: "rejected", reason: "conflict", message: "rejected" },
    ];

    for (const executionEvent of executionEvents) {
      expect(decodeExecutionEvent(executionEvent)).toMatchObject({ cellId: "cell-1" });
      const { cellId: _, ...missingCellId } = executionEvent;
      expect(() => decodeExecutionEvent(missingCellId)).toThrow();
    }

    expect(
      decodeExecutionEvent({
        type: "kernel",
        sessionId: "session-1",
        commandId: "restart-1",
        sequence: 2,
        state: "idle",
      }),
    ).not.toHaveProperty("cellId");
    expect(
      decodeExecutionEvent({
        type: "rejected",
        sessionId: "session-1",
        commandId: "restart-1",
        sequence: 3,
        reason: "conflict",
        message: "rejected",
      }),
    ).not.toHaveProperty("cellId");
  });

  it("requires an explicit retained-history baseline on replay responses", () => {
    const replay = decodeExecutionReplay({
      baselineSequence: 3,
      events: [
        {
          type: "kernel",
          sessionId: "session-1",
          commandId: "command-4",
          sequence: 4,
          state: "idle",
        },
      ],
    });

    expect(replay.baselineSequence).toBe(3);
    expect(replay.events[0]?.sequence).toBe(4);
    expect(() => decodeExecutionReplay({ events: replay.events })).toThrow();
  });
});
