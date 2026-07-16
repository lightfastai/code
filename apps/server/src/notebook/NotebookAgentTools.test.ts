import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type StudyTraceRecord,
} from "@t3tools/contracts";
import type { NotebookRevision } from "@t3tools/lightfast-artifact-notebook/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type { NotebookRevisionStoreShape } from "./NotebookRevisionStore.ts";
import { makeNotebookAgentTools } from "./NotebookAgentTools.ts";

const scope = {
  environmentId: EnvironmentId.make("environment-notebook-agent"),
  projectId: ProjectId.make("project-notebook-agent"),
};
const revision = {
  documentId: "notebook-agent",
  revisionId: "a".repeat(64),
  contentHash: "a".repeat(64),
  kernel: { name: "python3", displayName: "Python 3", language: "python" },
  document: {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
    },
    cells: [
      {
        cell_type: "code",
        id: "cell-1",
        metadata: {},
        source: "print('one')",
        execution_count: null,
        outputs: [],
      },
      { cell_type: "markdown", id: "note-1", metadata: {}, source: "Explanation" },
      {
        cell_type: "code",
        id: "cell-2",
        metadata: {},
        source: "print('two')",
        execution_count: null,
        outputs: [],
      },
    ],
  },
  createdAt: "2026-07-17T00:00:00.000Z",
} as NotebookRevision;

const invocation = (allowNotebookExecution: boolean): McpInvocationContext.McpInvocationScope => ({
  environmentId: scope.environmentId,
  threadId: ThreadId.make("thread-notebook-agent"),
  providerSessionId: "provider-session-notebook-agent",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["artifacts"]),
  allowNotebookExecution,
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const revisionStore: NotebookRevisionStoreShape = {
  read: () => Effect.succeed(revision),
  save: () => Effect.die("unused"),
  importIpynb: () => Effect.die("unused"),
  exportIpynb: () => Effect.die("unused"),
};

it.effect("rejects agent execution without the thread grant before touching the runtime", () => {
  const calls: string[] = [];
  const tools = makeNotebookAgentTools({
    revisionStore,
    runtimeManager: {
      open: async (input) => {
        calls.push("open");
        return [
          {
            type: "accepted",
            sessionId: input.sessionId,
            commandId: input.commandId,
            sequence: 1,
            commandType: "open",
          },
          {
            type: "kernel",
            sessionId: input.sessionId,
            commandId: input.commandId,
            sequence: 2,
            state: "idle",
          },
        ];
      },
      execute: () => ({ async *[Symbol.asyncIterator]() {} }),
      dispose: async () => {
        calls.push("dispose");
        return [];
      },
    },
    runtimeIdentity: () =>
      Effect.succeed({ imageDigest: `sha256:${"b".repeat(64)}`, kernelLockHash: "c".repeat(64) }),
    writeTrace: () => Effect.void,
    randomUUID: () => "denied",
    now: () => Date.parse("2026-07-17T00:00:00.000Z"),
  });

  return Effect.gen(function* () {
    const error = yield* tools
      .executeCell(
        {
          scope,
          documentId: revision.documentId,
          revisionId: revision.revisionId,
          cellId: "cell-1",
        },
        invocation(false),
      )
      .pipe(Effect.flip);

    expect(error).toMatchObject({ reason: "permission-denied" });
    expect(calls).toEqual([]);
  });
});

it.effect(
  "executes the exact revision and traces identity, ordered events, output, timing, and cleanup",
  () => {
    const calls: string[] = [];
    const traces: StudyTraceRecord[][] = [];
    let sequence = 0;
    const eventBase = (commandId: string) => ({
      sessionId: "notebook-agent-session-run-1",
      commandId,
      sequence: ++sequence,
    });
    const tools = makeNotebookAgentTools({
      revisionStore,
      runtimeManager: {
        open: async (input) => {
          calls.push(`open:${input.kernelName}`);
          return [
            { ...eventBase(input.commandId), type: "accepted", commandType: "open" },
            { ...eventBase(input.commandId), type: "kernel", state: "idle" },
          ];
        },
        execute: (input) => ({
          async *[Symbol.asyncIterator]() {
            calls.push(`execute:${input.cellId}:${input.code}`);
            const scoped = {
              sessionId: input.sessionId,
              commandId: input.commandId,
              executionId: input.executionId,
              cellId: input.cellId,
            };
            yield { ...scoped, sequence: ++sequence, type: "accepted", commandType: "execute" };
            yield { ...scoped, sequence: ++sequence, type: "execution", executionCount: 1 };
            yield {
              ...scoped,
              sequence: ++sequence,
              type: "stream",
              name: "stdout",
              text: "one\n",
            };
            yield { ...scoped, sequence: ++sequence, type: "kernel", state: "idle" };
          },
        }),
        dispose: async (input) => {
          calls.push("dispose");
          return [
            { ...eventBase(input.commandId), type: "accepted", commandType: "dispose" },
            { ...eventBase(input.commandId), type: "kernel", state: "terminated" },
          ];
        },
      },
      runtimeIdentity: () =>
        Effect.succeed({ imageDigest: `sha256:${"b".repeat(64)}`, kernelLockHash: "c".repeat(64) }),
      writeTrace: (_runId, records) => Effect.sync(() => traces.push([...records])),
      randomUUID: () => "run-1",
      now: (() => {
        let value = Date.parse("2026-07-17T00:00:00.000Z");
        return () => (value += 10);
      })(),
    });

    return Effect.gen(function* () {
      const result = yield* tools.executeCell(
        {
          scope,
          documentId: revision.documentId,
          revisionId: revision.revisionId,
          cellId: "cell-1",
        },
        invocation(true),
      );

      expect(calls).toEqual(["open:python3", "execute:cell-1:print('one')", "dispose"]);
      expect(result).toMatchObject({
        documentId: revision.documentId,
        revisionId: revision.revisionId,
        contentHash: revision.contentHash,
        traceRunId: "notebook-run-1",
      });
      expect(result.outputHash).toMatch(/^[0-9a-f]{64}$/);

      const execution = traces[0]?.find(({ event }) => event.type === "notebook_execution")?.event;
      expect(execution).toMatchObject({
        type: "notebook_execution",
        operation: "execute_cell",
        outcome: "completed",
        permissionGranted: true,
        binding: {
          documentId: revision.documentId,
          revisionId: revision.revisionId,
          contentHash: revision.contentHash,
          runtimeImageDigest: `sha256:${"b".repeat(64)}`,
          kernelLockHash: "c".repeat(64),
          kernelName: "python3",
        },
        isolation: {
          session: "ephemeral-exclusive",
          network: "disabled",
          hostWorkspace: "not-mounted",
        },
        cleanup: { attempted: true, succeeded: true },
      });
      if (execution?.type !== "notebook_execution") throw new Error("missing notebook trace");
      expect(execution.commands.map(({ type }) => type)).toEqual(["open", "execute", "dispose"]);
      expect(execution.runtimeEvents.map(({ sequence }) => sequence)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      expect(execution.outputHash).toBe(result.outputHash);
      expect(execution.durationMs).toBeGreaterThanOrEqual(0);
    });
  },
);

it.effect(
  "executes all code cells in document order and disposes after an execution failure",
  () => {
    const calls: string[] = [];
    const traces: StudyTraceRecord[][] = [];
    const tools = makeNotebookAgentTools({
      revisionStore,
      runtimeManager: {
        open: async (input) => {
          calls.push("open");
          return [
            {
              type: "accepted",
              sessionId: input.sessionId,
              commandId: input.commandId,
              sequence: 1,
              commandType: "open",
            },
            {
              type: "kernel",
              sessionId: input.sessionId,
              commandId: input.commandId,
              sequence: 2,
              state: "idle",
            },
          ];
        },
        execute: (input) => ({
          async *[Symbol.asyncIterator]() {
            calls.push(`execute:${input.cellId}`);
            if (input.cellId === "cell-2") throw new Error("kernel failed");
            yield* [];
          },
        }),
        dispose: async () => {
          calls.push("dispose");
          return [];
        },
      },
      runtimeIdentity: () =>
        Effect.succeed({ imageDigest: `sha256:${"b".repeat(64)}`, kernelLockHash: "c".repeat(64) }),
      writeTrace: (_runId, records) => Effect.sync(() => traces.push([...records])),
      randomUUID: () => "run-failure",
      now: () => Date.parse("2026-07-17T00:00:00.000Z"),
    });

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        tools.executeAll(
          { scope, documentId: revision.documentId, revisionId: revision.revisionId },
          invocation(true),
        ),
      );

      expect(result._tag).toBe("Failure");
      expect(calls).toEqual(["open", "execute:cell-1", "execute:cell-2", "dispose"]);
      expect(
        traces[0]?.find(({ event }) => event.type === "notebook_execution")?.event,
      ).toMatchObject({
        type: "notebook_execution",
        operation: "execute_all",
        outcome: "failed",
        cleanup: { attempted: true, succeeded: true },
      });
    });
  },
);

it.effect("treats runtime rejection as failure and still disposes the isolated session", () => {
  const calls: string[] = [];
  const tools = makeNotebookAgentTools({
    revisionStore,
    runtimeManager: {
      open: async (input) => {
        calls.push("open");
        return [
          {
            type: "accepted",
            sessionId: input.sessionId,
            commandId: input.commandId,
            sequence: 1,
            commandType: "open",
          },
          {
            type: "kernel",
            sessionId: input.sessionId,
            commandId: input.commandId,
            sequence: 2,
            state: "idle",
          },
        ];
      },
      execute: (input) => ({
        async *[Symbol.asyncIterator]() {
          calls.push("execute");
          yield {
            type: "rejected" as const,
            sessionId: input.sessionId,
            commandId: input.commandId,
            executionId: input.executionId,
            cellId: input.cellId,
            sequence: 3,
            reason: "execution-cancelled" as const,
            message: "rejected",
          };
        },
      }),
      dispose: async () => {
        calls.push("dispose");
        return [];
      },
    },
    runtimeIdentity: () =>
      Effect.succeed({ imageDigest: `sha256:${"b".repeat(64)}`, kernelLockHash: "c".repeat(64) }),
    writeTrace: () => Effect.void,
    randomUUID: () => "run-rejected",
    now: () => Date.parse("2026-07-17T00:00:00.000Z"),
  });

  return Effect.gen(function* () {
    const result = yield* Effect.result(
      tools.executeCell(
        {
          scope,
          documentId: revision.documentId,
          revisionId: revision.revisionId,
          cellId: "cell-1",
        },
        invocation(true),
      ),
    );

    expect(result._tag).toBe("Failure");
    expect(calls).toEqual(["open", "execute", "dispose"]);
  });
});

it.effect("disposes the isolated session when agent execution is interrupted", () => {
  const calls: string[] = [];
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const tools = makeNotebookAgentTools({
    revisionStore,
    runtimeManager: {
      open: async (input) => {
        calls.push("open");
        return [
          {
            type: "accepted",
            sessionId: input.sessionId,
            commandId: input.commandId,
            sequence: 1,
            commandType: "open",
          },
          {
            type: "kernel",
            sessionId: input.sessionId,
            commandId: input.commandId,
            sequence: 2,
            state: "idle",
          },
        ];
      },
      execute: () => ({
        async *[Symbol.asyncIterator]() {
          calls.push("execute");
          markStarted();
          await new Promise<never>(() => undefined);
          yield* [];
        },
      }),
      dispose: async () => {
        calls.push("dispose");
        return [];
      },
    },
    runtimeIdentity: () =>
      Effect.succeed({ imageDigest: `sha256:${"b".repeat(64)}`, kernelLockHash: "c".repeat(64) }),
    writeTrace: () => Effect.void,
    randomUUID: () => "run-interrupted",
    now: () => Date.parse("2026-07-17T00:00:00.000Z"),
  });

  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      tools.executeCell(
        {
          scope,
          documentId: revision.documentId,
          revisionId: revision.revisionId,
          cellId: "cell-1",
        },
        invocation(true),
      ),
    );
    yield* Effect.promise(() => started);
    yield* Fiber.interrupt(fiber);

    expect(calls).toEqual(["open", "execute", "dispose"]);
  });
});
