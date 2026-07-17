import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type {
  NotebookManagerExecuteInput,
  NotebookManagerSessionOpenInput,
  NotebookRuntimeManager,
} from "./NotebookRuntimeManager.ts";
import { makeNotebookRuntimeRpcHandlers } from "./NotebookRuntimeRpc.ts";

it.effect("forwards cell identity from execute RPC input to the runtime manager", () =>
  Effect.gen(function* () {
    let received: NotebookManagerExecuteInput | undefined;
    const manager = {
      execute: (input: NotebookManagerExecuteInput) => {
        received = input;
        return (async function* () {
          yield {
            type: "accepted" as const,
            sessionId: input.sessionId,
            commandId: input.commandId,
            executionId: input.executionId,
            cellId: input.cellId,
            sequence: 1,
            commandType: "execute" as const,
          };
        })();
      },
    } as unknown as NotebookRuntimeManager;
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = ProjectId.make("project-1");
    const handlers = makeNotebookRuntimeRpcHandlers({
      scopes: [AuthOrchestrationOperateScope],
      environmentId: Effect.succeed(environmentId),
      projectExists: () => Effect.succeed(true),
      resolveBookPaths: () => Effect.succeed([]),
      manager,
    });

    yield* handlers[WS_METHODS.notebookCellExecute]({
      scope: { environmentId, projectId },
      sessionId: "session-1",
      commandId: "command-1",
      executionId: "execution-1",
      cellId: "cell-1",
      code: "print('hello')",
    }).pipe(Stream.runCollect);

    assert.deepStrictEqual(received, {
      projectId,
      sessionId: "session-1",
      commandId: "command-1",
      executionId: "execution-1",
      cellId: "cell-1",
      code: "print('hello')",
    });
  }),
);

it.effect("resolves authenticated document IDs and forwards only canonical server paths", () =>
  Effect.gen(function* () {
    let receivedIds: ReadonlyArray<string> | undefined;
    let receivedOpen: NotebookManagerSessionOpenInput | undefined;
    const manager = {
      open: (input: NotebookManagerSessionOpenInput) => {
        receivedOpen = input;
        return Promise.resolve([]);
      },
    } as unknown as NotebookRuntimeManager;
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = ProjectId.make("project-1");
    const documentIds = ["a".repeat(64), "b".repeat(64)];
    const handlers = makeNotebookRuntimeRpcHandlers({
      scopes: [AuthOrchestrationOperateScope],
      environmentId: Effect.succeed(environmentId),
      projectExists: () => Effect.succeed(true),
      resolveBookPaths: (ids) =>
        Effect.sync(() => {
          receivedIds = ids;
          return ["/canonical/study-library/objects/aa/book.pdf"];
        }),
      manager,
    });

    yield* handlers[WS_METHODS.notebookSessionOpen]({
      scope: { environmentId, projectId },
      sessionId: "session-1",
      commandId: "open-1",
      kernelName: "python3",
      documentIds,
    });

    assert.deepStrictEqual(receivedIds, documentIds);
    assert.deepStrictEqual(receivedOpen, {
      projectId,
      sessionId: "session-1",
      commandId: "open-1",
      kernelName: "python3",
      bookPaths: ["/canonical/study-library/objects/aa/book.pdf"],
    });
  }),
);

it.effect("does not resolve mounts before environment and project authorization", () =>
  Effect.gen(function* () {
    let resolveCount = 0;
    let openCount = 0;
    const environmentId = EnvironmentId.make("environment-1");
    const projectId = ProjectId.make("project-1");
    const manager = {
      open: () => {
        openCount += 1;
        return Promise.resolve([]);
      },
    } as unknown as NotebookRuntimeManager;
    const makeHandlers = (projectExists: boolean) =>
      makeNotebookRuntimeRpcHandlers({
        scopes: [AuthOrchestrationOperateScope],
        environmentId: Effect.succeed(environmentId),
        projectExists: () => Effect.succeed(projectExists),
        resolveBookPaths: () =>
          Effect.sync(() => {
            resolveCount += 1;
            return ["/should-not-resolve"];
          }),
        manager,
      });
    const input = {
      scope: { environmentId, projectId },
      sessionId: "session-1",
      commandId: "open-1",
      kernelName: "python3",
      documentIds: ["a".repeat(64)],
    } as const;

    const wrongEnvironment = yield* Effect.result(
      makeHandlers(true)[WS_METHODS.notebookSessionOpen]({
        ...input,
        scope: { ...input.scope, environmentId: EnvironmentId.make("environment-other") },
      }),
    );
    const missingProject = yield* Effect.result(
      makeHandlers(false)[WS_METHODS.notebookSessionOpen](input),
    );

    assert.strictEqual(wrongEnvironment._tag, "Failure");
    assert.strictEqual(missingProject._tag, "Failure");
    assert.strictEqual(resolveCount, 0);
    assert.strictEqual(openCount, 0);
  }),
);
