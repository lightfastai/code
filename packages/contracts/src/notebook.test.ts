import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  NotebookAgentExecutionPermission,
  NotebookAgentExecutionPermissionGetInput,
  NotebookAgentExecutionPermissionSetInput,
  NotebookAgentExecuteAllInput,
  NotebookAgentExecuteCellInput,
  PublishNotebookArtifactInput,
  NotebookCellExecuteInput,
  NotebookExecutionEvent,
  NotebookExecutionReplay,
  NotebookSessionOpenInput,
} from "./notebook.ts";

const decodeExecuteInput = Schema.decodeUnknownSync(NotebookCellExecuteInput);
const decodeExecutionEvent = Schema.decodeUnknownSync(NotebookExecutionEvent);
const decodeExecutionReplay = Schema.decodeUnknownSync(NotebookExecutionReplay);
const decodePermission = Schema.decodeUnknownSync(NotebookAgentExecutionPermission);
const decodePermissionGet = Schema.decodeUnknownSync(NotebookAgentExecutionPermissionGetInput);
const decodePermissionSet = Schema.decodeUnknownSync(NotebookAgentExecutionPermissionSetInput);
const decodePublishNotebook = Schema.decodeUnknownSync(PublishNotebookArtifactInput);
const decodeExecuteCell = Schema.decodeUnknownSync(NotebookAgentExecuteCellInput);
const decodeExecuteAll = Schema.decodeUnknownSync(NotebookAgentExecuteAllInput);
const decodeSessionOpen = Schema.decodeUnknownSync(NotebookSessionOpenInput);

describe("notebook execution contracts", () => {
  it("accepts only explicit study document IDs for runtime mounts", () => {
    const documentIds = ["b".repeat(64), "a".repeat(64)];
    const open = decodeSessionOpen({
      scope: { environmentId: "environment-1", projectId: "project-1" },
      sessionId: "session-1",
      commandId: "open-1",
      kernelName: "python3",
      documentIds,
      bookPaths: ["/etc/passwd"],
    });

    expect(open).toMatchObject({ documentIds });
    expect(open).not.toHaveProperty("bookPaths");
    expect(() =>
      decodeSessionOpen({
        scope: open.scope,
        sessionId: "session-1",
        commandId: "open-1",
        kernelName: "python3",
      }),
    ).toThrow();
    expect(() => decodeSessionOpen({ ...open, documentIds: ["../../etc/passwd"] })).toThrow();
    expect(() =>
      decodeSessionOpen({ ...open, documentIds: Array.from({ length: 33 }, () => "a".repeat(64)) }),
    ).toThrow();
  });

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
      { ...base, type: "execution", executionCount: 1 },
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

describe("notebook agent contracts", () => {
  const revisionRef = {
    scope: { environmentId: "environment-1", projectId: "project-1" },
    documentId: "notebook-1",
    revisionId: "a".repeat(64),
    documentIds: ["b".repeat(64)],
  };

  it("requires explicit thread-scoped permission updates", () => {
    expect(decodePermissionGet({ threadId: "thread-1" })).toEqual({ threadId: "thread-1" });
    expect(decodePermissionSet({ threadId: "thread-1", allowNotebookExecution: true })).toEqual({
      threadId: "thread-1",
      allowNotebookExecution: true,
    });
    expect(decodePermission({ threadId: "thread-1", allowNotebookExecution: false })).toEqual({
      threadId: "thread-1",
      allowNotebookExecution: false,
    });
    expect(() => decodePermissionSet({ threadId: "thread-1" })).toThrow();
  });

  it("binds publication and execution to immutable notebook revisions", () => {
    expect(
      decodePublishNotebook({
        ...revisionRef,
        title: "Exact notebook",
        initialView: { mode: "cell", cellId: "cell-1" },
      }),
    ).toMatchObject({ documentId: "notebook-1", revisionId: "a".repeat(64) });
    expect(decodeExecuteCell({ ...revisionRef, cellId: "cell-1" })).toMatchObject({
      cellId: "cell-1",
    });
    expect(decodeExecuteAll(revisionRef)).toMatchObject({ documentId: "notebook-1" });
    expect(() =>
      decodeExecuteCell({ ...revisionRef, revisionId: "latest", cellId: "cell-1" }),
    ).toThrow();
    expect(() => {
      const { documentIds: _, ...missingDocumentIds } = revisionRef;
      decodeExecuteAll(missingDocumentIds);
    }).toThrow();
    expect(() =>
      decodePublishNotebook({
        ...revisionRef,
        documentIds: ["/tmp/private-book.pdf"],
        initialView: { mode: "notebook" },
      }),
    ).toThrow();
  });
});
