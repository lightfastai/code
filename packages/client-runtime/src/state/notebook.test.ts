import type { NotebookExecutionEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NOTEBOOK_RUNTIME_MAX_CELLS,
  NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL,
  NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_SESSION,
  NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_CELL,
  NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_SESSION,
  applyNotebookExecutionEvents,
  applyNotebookExecutionReplay,
  beginNotebookCellExecution,
  clearNotebookRuntimeError,
  createNotebookRuntimeState,
  failNotebookCellExecution,
  failNotebookRuntime,
  pruneNotebookRuntimeCell,
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
          cellId: "code-1",
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
        cellId: "code-1",
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
        cellId: "code-1",
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

  it("applies replayed scoped events directly to their cells", () => {
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
        cellId: "code-1",
        name: "stdout",
        text: "replayed\n",
      }),
    ]);

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
        cellId: "code-1",
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
        cellId: "code-1",
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
        cellId: "code-1",
        name: "stdout",
        text: "first ",
      }),
      event(4, {
        type: "stream",
        executionId: "execution-1",
        cellId: "code-1",
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
      event(1, {
        type: "kernel",
        executionId: "execution-1",
        cellId: "code-1",
        state: "busy",
      }),
      event(2, {
        type: "result",
        executionId: "execution-1",
        cellId: "code-1",
        executionCount: 3,
        metadata: {},
        data: { "text/plain": "3" },
      }),
      event(3, {
        type: "error",
        executionId: "execution-1",
        cellId: "code-1",
        ename: "ValueError",
        evalue: "bad",
        traceback: ["Traceback", "ValueError: bad"],
      }),
      event(4, {
        type: "limit",
        executionId: "execution-1",
        cellId: "code-1",
        kind: "output",
        limit: 1024,
        message: "Output was truncated.",
      }),
      event(5, {
        type: "kernel",
        executionId: "execution-1",
        cellId: "code-1",
        state: "idle",
      }),
    ]);

    expect(state.kernelStatus).toBe("idle");
    expect(state.executionCountByCell.get("code-1")).toBe(3);
    expect(state.outputsByCell.get("code-1")?.map((output) => output.output_type)).toEqual([
      "execute_result",
      "error",
    ]);
    expect(state.error).toBe("Output was truncated.");
  });

  it("reconstructs retained output when replay starts after the accepted event", () => {
    const state = applyNotebookExecutionReplay(createNotebookRuntimeState(), {
      baselineSequence: 3,
      events: [
        event(4, {
          type: "stream",
          executionId: "execution-trimmed",
          cellId: "code-trimmed",
          name: "stdout",
          text: "retained\n",
        }),
        event(5, {
          type: "result",
          executionId: "execution-trimmed",
          cellId: "code-trimmed",
          executionCount: 9,
          metadata: {},
          data: { "text/plain": "9" },
        }),
        event(6, {
          type: "kernel",
          executionId: "execution-trimmed",
          cellId: "code-trimmed",
          state: "idle",
        }),
      ],
    });

    expect(state.outputsByCell.get("code-trimmed")?.map((output) => output.output_type)).toEqual([
      "stream",
      "execute_result",
    ]);
    expect(state.executionCountByCell.get("code-trimmed")).toBe(9);
  });

  it("reconstructs active execution state from a mid-execution replay suffix", () => {
    let state = applyNotebookExecutionReplay(createNotebookRuntimeState(), {
      baselineSequence: 5,
      events: [
        event(6, {
          type: "stream",
          executionId: "execution-suffix",
          cellId: "code-suffix",
          name: "stdout",
          text: "still running\n",
        }),
      ],
    });

    expect(state.kernelStatus).toBe("busy");
    expect(state.runningCellIds.has("code-suffix")).toBe(true);

    state = applyNotebookExecutionEvents(state, [
      event(7, {
        type: "kernel",
        executionId: "execution-suffix",
        cellId: "code-suffix",
        state: "idle",
      }),
    ]);

    expect(state.kernelStatus).toBe("idle");
    expect(state.runningCellIds.has("code-suffix")).toBe(false);
  });

  it("preserves independent cells while globally busy across interleaved executions", () => {
    let state = applyNotebookExecutionReplay(createNotebookRuntimeState(), {
      baselineSequence: 1,
      events: [
        event(2, {
          type: "stream",
          executionId: "execution-a",
          cellId: "code-a",
          name: "stdout",
          text: "A running\n",
        }),
      ],
    });
    state = applyNotebookExecutionEvents(state, [
      event(3, {
        type: "accepted",
        commandType: "execute",
        executionId: "execution-b",
        cellId: "code-b",
      }),
      event(4, {
        type: "error",
        executionId: "execution-a",
        cellId: "code-a",
        ename: "ValueError",
        evalue: "A failed",
        traceback: ["ValueError: A failed"],
      }),
    ]);

    expect(state.runningCellIds).toEqual(new Set(["code-b"]));
    expect(state.kernelStatus).toBe("busy");
    expect(state.outputsByCell.get("code-a")?.map((output) => output.output_type)).toEqual([
      "stream",
      "error",
    ]);

    state = applyNotebookExecutionEvents(state, [
      event(5, {
        type: "stream",
        executionId: "execution-b",
        cellId: "code-b",
        name: "stdout",
        text: "B running\n",
      }),
      event(6, {
        type: "kernel",
        executionId: "execution-b",
        cellId: "code-b",
        state: "idle",
      }),
    ]);

    expect(state.runningCellIds.size).toBe(0);
    expect(state.kernelStatus).toBe("idle");
    expect(state.outputsByCell.get("code-b")).toEqual([
      { output_type: "stream", name: "stdout", text: "B running\n" },
    ]);
  });

  it("ignores stale events after a newer execution supersedes the same cell", () => {
    let state = applyNotebookExecutionEvents(createNotebookRuntimeState(), [
      event(1, {
        type: "accepted",
        commandType: "execute",
        executionId: "execution-a",
        cellId: "code-1",
      }),
      event(2, {
        type: "stream",
        executionId: "execution-a",
        cellId: "code-1",
        name: "stdout",
        text: "old output\n",
      }),
      event(3, {
        type: "accepted",
        commandType: "execute",
        executionId: "execution-b",
        cellId: "code-1",
      }),
      event(4, {
        type: "error",
        executionId: "execution-a",
        cellId: "code-1",
        ename: "OldError",
        evalue: "stale",
        traceback: ["OldError: stale"],
      }),
      event(5, {
        type: "execution",
        executionId: "execution-a",
        cellId: "code-1",
        executionCount: 99,
      }),
      event(6, {
        type: "stream",
        executionId: "execution-b",
        cellId: "code-1",
        name: "stdout",
        text: "new output\n",
      }),
    ]);

    expect(state.activeExecutionIdByCell.get("code-1")).toBe("execution-b");
    expect(state.runningCellIds).toEqual(new Set(["code-1"]));
    expect(state.executionCountByCell.has("code-1")).toBe(false);
    expect(state.outputsByCell.get("code-1")).toEqual([
      { output_type: "stream", name: "stdout", text: "new output\n" },
    ]);

    state = applyNotebookExecutionEvents(state, [
      event(7, {
        type: "kernel",
        executionId: "execution-a",
        cellId: "code-1",
        state: "idle",
      }),
      event(8, {
        type: "kernel",
        executionId: "execution-b",
        cellId: "code-1",
        state: "idle",
      }),
    ]);
    expect(state.runningCellIds.size).toBe(0);
    expect(state.kernelStatus).toBe("idle");

    state = applyNotebookExecutionEvents(state, [
      event(9, {
        type: "stream",
        executionId: "execution-a",
        cellId: "code-1",
        name: "stdout",
        text: "very late old output\n",
      }),
    ]);
    expect(state.runningCellIds.size).toBe(0);
    expect(state.outputsByCell.get("code-1")).toEqual([
      { output_type: "stream", name: "stdout", text: "new output\n" },
    ]);
  });

  it("clears stale active state when an authoritative replay jumps its baseline", () => {
    let state = applyNotebookExecutionEvents(createNotebookRuntimeState(), [
      event(1, {
        type: "accepted",
        commandType: "execute",
        executionId: "execution-a",
        cellId: "code-a",
      }),
    ]);
    expect(state.runningCellIds).toEqual(new Set(["code-a"]));

    state = applyNotebookExecutionReplay(state, {
      baselineSequence: 3,
      events: [
        event(4, {
          type: "stream",
          executionId: "execution-b",
          cellId: "code-b",
          name: "stdout",
          text: "retained B\n",
        }),
        event(5, {
          type: "kernel",
          executionId: "execution-b",
          cellId: "code-b",
          state: "idle",
        }),
      ],
    });

    expect(state.lastSequence).toBe(5);
    expect(state.activeExecutionIdByCell.size).toBe(0);
    expect(state.runningCellIds.size).toBe(0);
    expect(state.kernelStatus).toBe("idle");
    expect(state.outputsByCell.get("code-b")).toEqual([
      { output_type: "stream", name: "stdout", text: "retained B\n" },
    ]);
  });

  it("does not clear active state for a normal no-gap replay", () => {
    let state = applyNotebookExecutionEvents(createNotebookRuntimeState(), [
      event(1, {
        type: "accepted",
        commandType: "execute",
        executionId: "execution-a",
        cellId: "code-a",
      }),
    ]);
    state = applyNotebookExecutionReplay(state, {
      baselineSequence: 1,
      events: [
        event(2, {
          type: "stream",
          executionId: "execution-a",
          cellId: "code-a",
          name: "stdout",
          text: "continued A\n",
        }),
      ],
    });

    expect(state.activeExecutionIdByCell.get("code-a")).toBe("execution-a");
    expect(state.runningCellIds).toEqual(new Set(["code-a"]));
    expect(state.kernelStatus).toBe("busy");
  });

  it("treats every scoped nonterminal suffix as active and terminal errors as finished", () => {
    const nonterminalEvents: ReadonlyArray<EventInput> = [
      {
        type: "kernel",
        executionId: "execution-active",
        cellId: "code-active",
        state: "busy",
      },
      {
        type: "display",
        executionId: "execution-active",
        cellId: "code-active",
        data: { "text/plain": "display" },
        metadata: {},
      },
      {
        type: "result",
        executionId: "execution-active",
        cellId: "code-active",
        executionCount: 4,
        data: { "text/plain": "result" },
        metadata: {},
      },
      {
        type: "limit",
        executionId: "execution-active",
        cellId: "code-active",
        kind: "output",
        limit: 1024,
        message: "truncated",
      },
    ];

    for (const nonterminalEvent of nonterminalEvents) {
      const state = applyNotebookExecutionReplay(createNotebookRuntimeState(), {
        baselineSequence: 9,
        events: [event(10, nonterminalEvent)],
      });
      expect(state.kernelStatus).toBe("busy");
      expect(state.runningCellIds.has("code-active")).toBe(true);
    }

    const errored = applyNotebookExecutionReplay(createNotebookRuntimeState(), {
      baselineSequence: 9,
      events: [
        event(10, {
          type: "error",
          executionId: "execution-active",
          cellId: "code-active",
          ename: "ValueError",
          evalue: "bad",
          traceback: ["ValueError: bad"],
        }),
      ],
    });
    expect(errored.kernelStatus).toBe("idle");
    expect(errored.runningCellIds.has("code-active")).toBe(false);
  });

  it("records execute_input counts before any result output", () => {
    const state = applyNotebookExecutionReplay(createNotebookRuntimeState(), {
      baselineSequence: 20,
      events: [
        event(21, {
          type: "execution",
          executionId: "execution-counted",
          cellId: "code-counted",
          executionCount: 12,
        }),
        event(22, {
          type: "stream",
          executionId: "execution-counted",
          cellId: "code-counted",
          name: "stdout",
          text: "printed\n",
        }),
      ],
    });

    expect(state.executionCountByCell.get("code-counted")).toBe(12);
    expect(state.runningCellIds.has("code-counted")).toBe(true);
  });

  it("bounds every runtime cell index across 2,000 unique accepted executions", () => {
    const events: NotebookExecutionEvent[] = [];
    let sequence = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const cellId = `code-${index}`;
      const executionId = `execution-${index}`;
      events.push(
        event(++sequence, {
          type: "accepted",
          commandType: "execute",
          executionId,
          cellId,
        }),
        event(++sequence, {
          type: "kernel",
          executionId,
          cellId,
          state: "idle",
        }),
      );
    }

    const state = applyNotebookExecutionEvents(createNotebookRuntimeState(), events);

    expect(state.activeExecutionIdByCell.size).toBe(0);
    expect(state.runningCellIds.size).toBe(0);
    expect(state.latestExecutionIdByCell.size).toBeLessThanOrEqual(NOTEBOOK_RUNTIME_MAX_CELLS);
    expect(state.executionCountByCell.size).toBeLessThanOrEqual(NOTEBOOK_RUNTIME_MAX_CELLS);
    expect(state.outputsByCell.size).toBeLessThanOrEqual(NOTEBOOK_RUNTIME_MAX_CELLS);
    expect(state.outputKeysByCell.size).toBeLessThanOrEqual(NOTEBOOK_RUNTIME_MAX_CELLS);
    expect(state.outputEntryBytesByCell.size).toBeLessThanOrEqual(NOTEBOOK_RUNTIME_MAX_CELLS);
    expect(state.outputBytesByCell.size).toBeLessThanOrEqual(NOTEBOOK_RUNTIME_MAX_CELLS);
    expect(state.outputRetentionByCell.size).toBeLessThanOrEqual(NOTEBOOK_RUNTIME_MAX_CELLS);
    expect(state.outputCellRecency).toHaveLength(NOTEBOOK_RUNTIME_MAX_CELLS);
    expect(state.runtimeCellRecency).toHaveLength(NOTEBOOK_RUNTIME_MAX_CELLS);
    expect(state.latestExecutionIdByCell.has("code-0")).toBe(false);
    expect(state.latestExecutionIdByCell.get("code-1999")).toBe("execution-1999");
  });

  it("never evicts active cells and deterministically evicts the oldest inactive cell", () => {
    let state = beginNotebookCellExecution(
      createNotebookRuntimeState(),
      "code-active",
      "execution-active",
    );
    let sequence = 0;
    for (let index = 0; index < NOTEBOOK_RUNTIME_MAX_CELLS; index += 1) {
      state = applyNotebookExecutionEvents(state, [
        event(++sequence, {
          type: "accepted",
          commandType: "execute",
          executionId: `execution-${index}`,
          cellId: `code-${index}`,
        }),
        event(++sequence, {
          type: "kernel",
          executionId: `execution-${index}`,
          cellId: `code-${index}`,
          state: "idle",
        }),
      ]);
    }

    expect(state.activeExecutionIdByCell.get("code-active")).toBe("execution-active");
    expect(state.runningCellIds.has("code-active")).toBe(true);
    expect(state.latestExecutionIdByCell.has("code-active")).toBe(true);
    expect(state.latestExecutionIdByCell.has("code-0")).toBe(false);
    expect(state.latestExecutionIdByCell.has(`code-${NOTEBOOK_RUNTIME_MAX_CELLS - 1}`)).toBe(true);
    expect(state.runtimeCellRecency).toHaveLength(NOTEBOOK_RUNTIME_MAX_CELLS);
  });

  it("prunes every runtime index and accounting entry for a removed cell", () => {
    const cellId = "code-removed";
    const executionId = "execution-removed";
    const events: NotebookExecutionEvent[] = [
      event(1, { type: "accepted", commandType: "execute", executionId, cellId }),
      event(2, { type: "execution", executionId, cellId, executionCount: 7 }),
    ];
    for (let index = 0; index <= NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_CELL; index += 1) {
      events.push(
        event(events.length + 1, {
          type: "display",
          executionId,
          cellId,
          data: { "text/plain": `output-${index}` },
          metadata: {},
        }),
      );
    }
    events.push(
      event(events.length + 1, {
        type: "kernel",
        executionId,
        cellId,
        state: "idle",
      }),
    );
    const populated = applyNotebookExecutionEvents(createNotebookRuntimeState(), events);
    expect(populated.outputRetentionByCell.has(cellId)).toBe(true);

    const state = pruneNotebookRuntimeCell(populated, cellId);

    expect(state.activeExecutionIdByCell.has(cellId)).toBe(false);
    expect(state.latestExecutionIdByCell.has(cellId)).toBe(false);
    expect(state.executionCountByCell.has(cellId)).toBe(false);
    expect(state.runningCellIds.has(cellId)).toBe(false);
    expect(state.outputsByCell.has(cellId)).toBe(false);
    expect(state.outputKeysByCell.has(cellId)).toBe(false);
    expect(state.outputEntryBytesByCell.has(cellId)).toBe(false);
    expect(state.outputBytesByCell.has(cellId)).toBe(false);
    expect(state.outputRetentionByCell.has(cellId)).toBe(false);
    expect(state.outputCellRecency).not.toContain(cellId);
    expect(state.runtimeCellRecency).not.toContain(cellId);
  });

  it("bounds output entries and bytes per cell and per session with stable retained keys", () => {
    let state = createNotebookRuntimeState();
    let sequence = 0;
    state = applyNotebookExecutionEvents(state, [
      event(++sequence, {
        type: "accepted",
        commandType: "execute",
        executionId: "execution-cell",
        cellId: "code-cell",
      }),
    ]);
    for (let index = 0; index < NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_CELL; index += 1) {
      state = applyNotebookExecutionEvents(state, [
        event(++sequence, {
          type: "display",
          executionId: "execution-cell",
          cellId: "code-cell",
          data: { "text/plain": `entry-${index}` },
          metadata: {},
        }),
      ]);
    }
    const keyThatShouldSurvive = state.outputKeysByCell.get("code-cell")?.[2];
    for (let index = 0; index < 2; index += 1) {
      state = applyNotebookExecutionEvents(state, [
        event(++sequence, {
          type: "display",
          executionId: "execution-cell",
          cellId: "code-cell",
          data: { "text/plain": `overflow-${index}` },
          metadata: {},
        }),
      ]);
    }

    expect(state.outputsByCell.get("code-cell")).toHaveLength(
      NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_CELL,
    );
    expect(state.outputKeysByCell.get("code-cell")?.[0]).toBe(keyThatShouldSurvive);
    expect(state.outputRetentionByCell.get("code-cell")?.omittedEntries).toBe(2);
    expect(state.outputBytesByCell.get("code-cell")).toBeLessThanOrEqual(
      NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL,
    );

    const largeText = "x".repeat(NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL);
    for (let index = 0; index < 8; index += 1) {
      const cellId = `session-cell-${index}`;
      const executionId = `session-execution-${index}`;
      state = applyNotebookExecutionEvents(state, [
        event(++sequence, {
          type: "accepted",
          commandType: "execute",
          executionId,
          cellId,
        }),
        event(++sequence, {
          type: "stream",
          executionId,
          cellId,
          name: "stdout",
          text: largeText,
        }),
      ]);
    }

    const retainedEntries = [...state.outputsByCell.values()].reduce(
      (total, outputs) => total + outputs.length,
      0,
    );
    const retainedBytes = [...state.outputBytesByCell.values()].reduce(
      (total, bytes) => total + bytes,
      0,
    );
    expect(retainedEntries).toBeLessThanOrEqual(NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_SESSION);
    expect(retainedBytes).toBeLessThanOrEqual(NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_SESSION);
    expect(
      [...state.outputRetentionByCell.values()].reduce(
        (total, retention) => total + retention.omittedBytes + retention.omittedEntries,
        0,
      ),
    ).toBeGreaterThan(0);
  });

  it("tail-truncates oversized streams and omits oversized non-stream entries", () => {
    let state = applyNotebookExecutionEvents(createNotebookRuntimeState(), [
      event(1, {
        type: "accepted",
        commandType: "execute",
        executionId: "execution-large",
        cellId: "code-large",
      }),
      event(2, {
        type: "stream",
        executionId: "execution-large",
        cellId: "code-large",
        name: "stdout",
        text: `discarded-prefix-${"x".repeat(NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL)}-retained-tail`,
      }),
    ]);

    const stream = state.outputsByCell.get("code-large")?.[0];
    expect(stream).toMatchObject({ output_type: "stream" });
    expect(stream?.output_type === "stream" ? stream.text.endsWith("-retained-tail") : false).toBe(
      true,
    );
    expect(
      stream?.output_type === "stream" ? stream.text.startsWith("discarded-prefix-") : true,
    ).toBe(false);
    expect(state.outputRetentionByCell.get("code-large")?.omittedBytes).toBeGreaterThan(0);

    state = applyNotebookExecutionEvents(state, [
      event(3, {
        type: "display",
        executionId: "execution-large",
        cellId: "code-large",
        data: { "text/plain": "y".repeat(NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL) },
        metadata: {},
      }),
    ]);

    expect(state.outputsByCell.get("code-large")).toHaveLength(1);
    expect(state.outputRetentionByCell.get("code-large")?.omittedEntries).toBe(1);
  });

  it("clears recoverable controller errors", () => {
    const failed = failNotebookRuntime(createNotebookRuntimeState(), "Runtime unavailable");
    expect(failed.error).toBe("Runtime unavailable");
    expect(clearNotebookRuntimeError(failed).error).toBeNull();
  });

  it("rolls back only the optimistic execution whose RPC failed before any event", () => {
    const optimistic = beginNotebookCellExecution(
      createNotebookRuntimeState(),
      "code-rpc",
      "execution-rpc",
    );
    const failed = failNotebookCellExecution(
      optimistic,
      "code-rpc",
      "execution-rpc",
      "RPC rejected before streaming.",
    );

    expect(failed.runningCellIds.has("code-rpc")).toBe(false);
    expect(failed.error).toBe("RPC rejected before streaming.");

    const superseded = beginNotebookCellExecution(optimistic, "code-rpc", "execution-newer");
    const staleFailure = failNotebookCellExecution(
      superseded,
      "code-rpc",
      "execution-rpc",
      "Late failure.",
    );
    expect(staleFailure.runningCellIds.has("code-rpc")).toBe(true);
  });
});
