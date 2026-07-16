import {
  NotebookAgentToolError,
  type NotebookAgentExecuteAllInput,
  type NotebookAgentExecuteCellInput,
  type NotebookAgentExecutionResult,
  type NotebookExecutionEvent,
  type StudyNotebookCommand,
  type StudyNotebookExecutionEvent,
  type StudyTraceRecord,
  type StudyTraceRunId,
} from "@t3tools/contracts";
import { NotebookCodeCell } from "@t3tools/lightfast-artifact-notebook/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { buildStudyTraceRecord, hashStudyValue } from "../study/StudyTraceStore.ts";
import type { NotebookRevisionStoreShape } from "./NotebookRevisionStore.ts";
import type {
  NotebookManagerControlInput,
  NotebookManagerExecuteInput,
  NotebookManagerSessionOpenInput,
} from "./NotebookRuntimeManager.ts";

type NotebookCodeCellValue = typeof NotebookCodeCell.Type;

const NOTEBOOK_AGENT_SKILL_HASH =
  "106e61ff807f8496e45217d9a08c283960b17f41f6efe273f47133bac55a5635";

export interface NotebookAgentRuntimeManager {
  readonly open: (
    input: NotebookManagerSessionOpenInput,
  ) => Promise<ReadonlyArray<NotebookExecutionEvent>>;
  readonly execute: (input: NotebookManagerExecuteInput) => AsyncIterable<NotebookExecutionEvent>;
  readonly dispose: (
    input: NotebookManagerControlInput,
  ) => Promise<ReadonlyArray<NotebookExecutionEvent>>;
}

export interface NotebookAgentToolsDependencies {
  readonly revisionStore: NotebookRevisionStoreShape;
  readonly runtimeManager: NotebookAgentRuntimeManager;
  readonly runtimeIdentity: () => Effect.Effect<
    {
      readonly imageDigest: string;
      readonly kernelLockHash: string;
    },
    NotebookAgentToolError
  >;
  readonly writeTrace: (
    runId: StudyTraceRunId,
    records: ReadonlyArray<StudyTraceRecord>,
  ) => Effect.Effect<void, NotebookAgentToolError>;
  readonly randomUUID: () => string;
  readonly now: () => number;
}

const toolError = (
  reason: NotebookAgentToolError["reason"],
  message: string,
): NotebookAgentToolError => new NotebookAgentToolError({ reason, message });

const runtimeError = (): NotebookAgentToolError =>
  toolError("execution-failed", "The isolated notebook execution failed.");

const traceError = (): NotebookAgentToolError =>
  toolError("trace-failed", "The notebook execution trace could not be persisted.");

const timestamp = (milliseconds: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(milliseconds));

const outputEvents = (events: ReadonlyArray<NotebookExecutionEvent>) =>
  events.filter((event) => ["stream", "display", "result", "error", "limit"].includes(event.type));

function traceRecords(input: {
  readonly runId: StudyTraceRunId;
  readonly timestamp: string;
  readonly event: StudyNotebookExecutionEvent;
}): ReadonlyArray<StudyTraceRecord> {
  const start = buildStudyTraceRecord({
    runId: input.runId,
    sequence: 0,
    timestamp: input.event.startedAt,
    previousHash: null,
    event: {
      type: "run_started",
      skill: {
        name: "notebook-agent-tools",
        version: "1",
        contentHash: NOTEBOOK_AGENT_SKILL_HASH,
        source: "builtin://notebook-agent-tools",
      },
      runtime: {
        adapter: { id: "mcp/notebook", version: "1" },
        model: { provider: "local", name: "isolated-jupyter" },
        tools: [
          {
            name:
              input.event.operation === "execute_cell"
                ? "notebook_execute_cell"
                : "notebook_execute_all",
            version: "1",
          },
        ],
      },
      documentIds: [],
    },
  });
  const execution = buildStudyTraceRecord({
    runId: input.runId,
    sequence: 1,
    timestamp: input.timestamp,
    previousHash: start.hash,
    event: input.event,
  });
  const finished = buildStudyTraceRecord({
    runId: input.runId,
    sequence: 2,
    timestamp: input.timestamp,
    previousHash: execution.hash,
    event: {
      type: "run_finished",
      reason: input.event.outcome === "completed" ? "completed" : "error",
    },
  });
  return [start, execution, finished];
}

function requestedRevision(input: NotebookAgentExecuteAllInput | NotebookAgentExecuteCellInput) {
  return {
    scope: input.scope,
    documentId: input.documentId,
    revisionId: input.revisionId,
  };
}

export function makeNotebookAgentTools(dependencies: NotebookAgentToolsDependencies) {
  const execute = Effect.fn("NotebookAgentTools.execute")(function* (
    operation: "execute_cell" | "execute_all",
    input: NotebookAgentExecuteAllInput | NotebookAgentExecuteCellInput,
    invocation: McpInvocationContext.McpInvocationScope,
  ) {
    if (!invocation.allowNotebookExecution) {
      return yield* toolError(
        "permission-denied",
        "This thread does not grant notebook execution to the agent.",
      );
    }
    if (input.scope.environmentId !== invocation.environmentId) {
      return yield* toolError(
        "scope-mismatch",
        "The notebook revision belongs to a different environment.",
      );
    }

    const revision = yield* dependencies.revisionStore
      .read(requestedRevision(input))
      .pipe(
        Effect.mapError((cause) =>
          toolError(
            cause.reason === "not-found" ? "revision-not-found" : "execution-failed",
            cause.reason === "not-found"
              ? "The requested immutable notebook revision was not found."
              : "The immutable notebook revision could not be read.",
          ),
        ),
      );
    const cells: ReadonlyArray<NotebookCodeCellValue> =
      operation === "execute_all"
        ? revision.document.cells.filter(
            (cell): cell is NotebookCodeCellValue => cell.cell_type === "code",
          )
        : revision.document.cells.filter(
            (cell): cell is NotebookCodeCellValue =>
              cell.cell_type === "code" &&
              cell.id === (input as NotebookAgentExecuteCellInput).cellId,
          );
    if (operation === "execute_cell" && cells.length === 0) {
      return yield* toolError("cell-not-found", "The requested code cell was not found.");
    }

    const identity = yield* dependencies
      .runtimeIdentity()
      .pipe(
        Effect.mapError(() =>
          toolError("runtime-unavailable", "The exact notebook runtime identity is unavailable."),
        ),
      );
    const uuid = dependencies.randomUUID().replace(/[^A-Za-z0-9_-]/g, "-");
    const runId = `notebook-${uuid}` as StudyTraceRunId;
    const sessionId = `notebook-agent-session-${uuid}`.slice(0, 128);
    const startedAtMs = dependencies.now();
    const startedAt = timestamp(startedAtMs);
    const commands: StudyNotebookCommand[] = [];
    const runtimeEvents: NotebookExecutionEvent[] = [];
    const commandId = (kind: string, index?: number) =>
      `notebook-${kind}-${uuid}${index === undefined ? "" : `-${index}`}`.slice(0, 256);
    const openCommandId = commandId("open");
    commands.push({
      type: "open",
      commandId: openCommandId,
      startedAt: timestamp(dependencies.now()),
    });

    let executionFailure: NotebookAgentToolError | undefined;
    let opened = false;
    let cleanupAttempted = false;
    let cleanupSucceeded = false;
    let disposeCommandId: string | undefined;
    const cleanup = Effect.fn("NotebookAgentTools.cleanup")(function* () {
      if (!opened || cleanupAttempted) return;
      cleanupAttempted = true;
      disposeCommandId = commandId("dispose");
      commands.push({
        type: "dispose",
        commandId: disposeCommandId,
        startedAt: timestamp(dependencies.now()),
      });
      const disposeResult = yield* Effect.result(
        Effect.tryPromise({
          try: () =>
            dependencies.runtimeManager.dispose({
              projectId: input.scope.projectId,
              sessionId,
              commandId: disposeCommandId as string,
            }),
          catch: runtimeError,
        }),
      );
      if (disposeResult._tag === "Success") {
        cleanupSucceeded = true;
        runtimeEvents.push(...disposeResult.success);
      } else {
        executionFailure ??= disposeResult.failure;
      }
    });

    const openResult = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* Effect.result(
          Effect.tryPromise({
            try: () =>
              dependencies.runtimeManager.open({
                projectId: input.scope.projectId,
                sessionId,
                commandId: openCommandId,
                kernelName: revision.kernel.name,
              }),
            catch: runtimeError,
          }),
        );
        if (
          result._tag === "Success" &&
          result.success.some(
            (event) => event.type === "accepted" && event.commandType === "open",
          ) &&
          result.success.some((event) => event.type === "kernel" && event.state === "idle")
        ) {
          opened = true;
          yield* Effect.addFinalizer(() => cleanup().pipe(Effect.ignore));
        }
        return result;
      }),
    );
    if (openResult._tag === "Success") {
      runtimeEvents.push(...openResult.success);
      if (!opened) {
        executionFailure = runtimeError();
      } else {
        for (const [index, cell] of cells.entries()) {
          const executeCommandId = commandId("execute", index);
          const executionId = commandId("execution", index);
          commands.push({
            type: "execute",
            commandId: executeCommandId,
            executionId,
            cellId: cell.id,
            codeHash: hashStudyValue(cell.source),
            startedAt: timestamp(dependencies.now()),
          });
          const cellResult = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                Array.fromAsync(
                  dependencies.runtimeManager.execute({
                    projectId: input.scope.projectId,
                    sessionId,
                    commandId: executeCommandId,
                    executionId,
                    cellId: cell.id,
                    code: cell.source,
                  }),
                ),
              catch: runtimeError,
            }),
          );
          if (cellResult._tag === "Failure") {
            executionFailure = cellResult.failure;
            break;
          }
          runtimeEvents.push(...cellResult.success);
          if (
            cellResult.success.some((event) => ["rejected", "error", "limit"].includes(event.type))
          ) {
            executionFailure = runtimeError();
            break;
          }
        }
      }
    } else {
      executionFailure = openResult.failure;
    }

    yield* cleanup();

    const finishedAtMs = dependencies.now();
    const finishedAt = timestamp(finishedAtMs);
    const outputHash = hashStudyValue(outputEvents(runtimeEvents));
    const event: StudyNotebookExecutionEvent = {
      type: "notebook_execution",
      operation,
      outcome: executionFailure === undefined ? "completed" : "failed",
      permissionGranted: true,
      binding: {
        documentId: revision.documentId,
        revisionId: revision.revisionId,
        contentHash: revision.contentHash,
        runtimeImageDigest: identity.imageDigest,
        kernelLockHash: identity.kernelLockHash,
        kernelName: revision.kernel.name,
      },
      sessionId,
      isolation: {
        session: "ephemeral-exclusive",
        network: "disabled",
        hostWorkspace: "not-mounted",
      },
      commands,
      runtimeEvents,
      outputHash,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAtMs - startedAtMs),
      cleanup: {
        attempted: cleanupAttempted,
        succeeded: cleanupSucceeded,
        ...(disposeCommandId === undefined ? {} : { commandId: disposeCommandId }),
      },
    };
    const records = traceRecords({ runId, timestamp: finishedAt, event });
    const traceResult = yield* Effect.result(dependencies.writeTrace(runId, records));
    if (traceResult._tag === "Failure") return yield* traceError();
    if (executionFailure !== undefined) return yield* executionFailure;

    return {
      documentId: revision.documentId,
      revisionId: revision.revisionId,
      contentHash: revision.contentHash,
      traceRunId: runId,
      outputHash,
      durationMs: event.durationMs,
    } satisfies NotebookAgentExecutionResult;
  });

  return {
    executeCell: (
      input: NotebookAgentExecuteCellInput,
      invocation: McpInvocationContext.McpInvocationScope,
    ) => execute("execute_cell", input, invocation).pipe(Effect.scoped),
    executeAll: (
      input: NotebookAgentExecuteAllInput,
      invocation: McpInvocationContext.McpInvocationScope,
    ) => execute("execute_all", input, invocation).pipe(Effect.scoped),
  } as const;
}
