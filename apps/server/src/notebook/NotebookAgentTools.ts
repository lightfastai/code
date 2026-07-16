import {
  NotebookAgentToolError,
  type NotebookAgentExecuteAllInput,
  type NotebookAgentExecuteCellInput,
  type NotebookAgentExecutionResult,
  type NotebookExecutionEvent,
  type StudyNotebookCommand,
  type StudyNotebookExecutionEvent,
  type StudyNotebookPermissionEvent,
  type StudyTraceEvent,
  type StudyTraceRecord,
  type StudyTraceRunId,
} from "@t3tools/contracts";
import { NotebookCodeCell } from "@t3tools/lightfast-artifact-notebook/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

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
  readonly withExecutionStart: <A, E, R>(
    invocation: McpInvocationContext.McpInvocationScope,
    start: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | NotebookAgentToolError, R>;
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

function semanticOutput(events: ReadonlyArray<NotebookExecutionEvent>): ReadonlyArray<unknown> {
  const output: unknown[] = [];
  for (const event of events) {
    switch (event.type) {
      case "stream":
        output.push({ type: event.type, cellId: event.cellId, name: event.name, text: event.text });
        break;
      case "display":
        output.push({
          type: event.type,
          cellId: event.cellId,
          data: event.data,
          metadata: event.metadata,
        });
        break;
      case "result":
        output.push({
          type: event.type,
          cellId: event.cellId,
          data: event.data,
          metadata: event.metadata,
        });
        break;
      case "error":
        output.push({
          type: event.type,
          cellId: event.cellId,
          ename: event.ename,
          evalue: event.evalue,
          traceback: event.traceback,
        });
        break;
      case "limit":
        output.push({
          type: event.type,
          cellId: event.cellId,
          kind: event.kind,
          limit: event.limit,
          message: event.message,
        });
        break;
      default:
        break;
    }
  }
  return output;
}

function traceRecords(input: {
  readonly runId: StudyTraceRunId;
  readonly operation: StudyNotebookExecutionEvent["operation"];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly permission: StudyNotebookPermissionEvent;
  readonly execution?: StudyNotebookExecutionEvent;
  readonly finishedReason: "completed" | "cancelled" | "error";
}): ReadonlyArray<StudyTraceRecord> {
  const start = buildStudyTraceRecord({
    runId: input.runId,
    sequence: 0,
    timestamp: input.startedAt,
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
              input.operation === "execute_cell" ? "notebook_execute_cell" : "notebook_execute_all",
            version: "1",
          },
        ],
      },
      documentIds: [],
    },
  });
  const middleEvents: ReadonlyArray<StudyTraceEvent> = [
    input.permission,
    ...(input.execution === undefined ? [] : [input.execution]),
  ];
  let previousHash = start.hash;
  const middle = middleEvents.map((event, index) => {
    const record = buildStudyTraceRecord({
      runId: input.runId,
      sequence: index + 1,
      timestamp: event.type === "notebook_permission" ? input.startedAt : input.finishedAt,
      previousHash,
      event,
    });
    previousHash = record.hash;
    return record;
  });
  const finished = buildStudyTraceRecord({
    runId: input.runId,
    sequence: middle.length + 1,
    timestamp: input.finishedAt,
    previousHash,
    event: {
      type: "run_finished",
      reason: input.finishedReason,
    },
  });
  return [start, ...middle, finished];
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
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
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

        let permissionGranted = false;
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
          if (disposeResult._tag === "Failure") {
            executionFailure ??= disposeResult.failure;
            return;
          }
          runtimeEvents.push(...disposeResult.success);
          const accepted = disposeResult.success.some(
            (event) =>
              event.sessionId === sessionId &&
              event.commandId === disposeCommandId &&
              event.type === "accepted" &&
              event.commandType === "dispose",
          );
          const terminated = disposeResult.success.some(
            (event) =>
              event.sessionId === sessionId &&
              event.commandId === disposeCommandId &&
              event.type === "kernel" &&
              event.state === "terminated",
          );
          cleanupSucceeded = accepted && terminated;
          if (!cleanupSucceeded) executionFailure ??= runtimeError();
        });

        const bodyExit = yield* Effect.exit(
          restore(
            Effect.gen(function* () {
              const openResult = yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const result = yield* Effect.result(
                    dependencies.withExecutionStart(
                      invocation,
                      Effect.sync(() => {
                        permissionGranted = true;
                      }).pipe(
                        Effect.andThen(
                          Effect.tryPromise({
                            try: () =>
                              dependencies.runtimeManager.open({
                                projectId: input.scope.projectId,
                                sessionId,
                                commandId: openCommandId,
                                kernelName: revision.kernel.name,
                                runtimeImageDigest: identity.imageDigest,
                              }),
                            catch: runtimeError,
                          }),
                        ),
                      ),
                    ),
                  );
                  if (result._tag === "Success") {
                    runtimeEvents.push(...result.success);
                    opened =
                      result.success.some(
                        (event) =>
                          event.sessionId === sessionId &&
                          event.commandId === openCommandId &&
                          event.type === "accepted" &&
                          event.commandType === "open",
                      ) &&
                      result.success.some(
                        (event) =>
                          event.sessionId === sessionId &&
                          event.commandId === openCommandId &&
                          event.type === "kernel" &&
                          event.state === "idle",
                      );
                  }
                  return result;
                }),
              );
              if (openResult._tag === "Failure") {
                executionFailure = openResult.failure;
                return;
              }
              if (!opened) {
                executionFailure = runtimeError();
                return;
              }

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
                  cellResult.success.some((event) =>
                    ["rejected", "error", "limit"].includes(event.type),
                  )
                ) {
                  executionFailure = runtimeError();
                  break;
                }
              }
            }),
          ),
        );

        const interrupted = Exit.hasInterrupts(bodyExit);
        yield* cleanup();

        const finishedAtMs = dependencies.now();
        const finishedAt = timestamp(finishedAtMs);
        const outputHash = hashStudyValue(semanticOutput(runtimeEvents));
        const permission: StudyNotebookPermissionEvent = {
          type: "notebook_permission",
          operation,
          threadId: invocation.threadId,
          providerSessionId: invocation.providerSessionId,
          permissionGranted,
        };
        const event: StudyNotebookExecutionEvent | undefined = permissionGranted
          ? {
              type: "notebook_execution",
              operation,
              outcome: interrupted
                ? "interrupted"
                : executionFailure === undefined && bodyExit._tag === "Success"
                  ? "completed"
                  : "failed",
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
            }
          : undefined;
        const records = traceRecords({
          runId,
          operation,
          startedAt,
          finishedAt,
          permission,
          ...(event === undefined ? {} : { execution: event }),
          finishedReason: interrupted
            ? "cancelled"
            : executionFailure === undefined && bodyExit._tag === "Success"
              ? "completed"
              : "error",
        });
        const traceResult = yield* Effect.result(dependencies.writeTrace(runId, records));
        if (traceResult._tag === "Failure") return yield* traceError();
        if (bodyExit._tag === "Failure") return yield* Effect.failCause(bodyExit.cause);
        if (executionFailure !== undefined) return yield* executionFailure;
        if (event === undefined) return yield* runtimeError();

        return {
          documentId: revision.documentId,
          revisionId: revision.revisionId,
          contentHash: revision.contentHash,
          traceRunId: runId,
          outputHash,
          durationMs: event.durationMs,
        } satisfies NotebookAgentExecutionResult;
      }),
    );
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
