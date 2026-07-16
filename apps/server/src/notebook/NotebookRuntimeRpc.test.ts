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
