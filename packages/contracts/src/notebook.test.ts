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
