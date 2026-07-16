import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  NotebookRuntimeError,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type NotebookCellExecuteInput,
  type NotebookExecutionControlInput,
  type NotebookSessionEventsInput,
  type NotebookSessionOpenInput,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  type NotebookRuntimeManager,
  NotebookRuntimeManagerError,
} from "./NotebookRuntimeManager.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export type NotebookRuntimeRpcMethod =
  | typeof WS_METHODS.notebookSessionOpen
  | typeof WS_METHODS.notebookCellExecute
  | typeof WS_METHODS.notebookExecutionInterrupt
  | typeof WS_METHODS.notebookKernelRestart
  | typeof WS_METHODS.notebookSessionDispose
  | typeof WS_METHODS.notebookSessionEvents;

export const NOTEBOOK_RUNTIME_RPC_SCOPES = {
  [WS_METHODS.notebookSessionOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.notebookCellExecute]: AuthOrchestrationOperateScope,
  [WS_METHODS.notebookExecutionInterrupt]: AuthOrchestrationOperateScope,
  [WS_METHODS.notebookKernelRestart]: AuthOrchestrationOperateScope,
  [WS_METHODS.notebookSessionDispose]: AuthOrchestrationOperateScope,
  [WS_METHODS.notebookSessionEvents]: AuthOrchestrationReadScope,
} as const satisfies Record<NotebookRuntimeRpcMethod, AuthEnvironmentScope>;

export interface NotebookRuntimeRpcDependencies {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly environmentId: Effect.Effect<EnvironmentId>;
  readonly projectExists: (
    projectId: ProjectId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly manager: NotebookRuntimeManager;
}

const runtimeFailure = (cause: unknown): NotebookRuntimeError => {
  if (cause instanceof NotebookRuntimeManagerError) {
    switch (cause.reason) {
      case "session-not-found":
        return new NotebookRuntimeError({
          reason: "session-not-found",
          message: "Notebook session was not found.",
        });
      case "docker-failed":
      case "runtime-unavailable":
        return new NotebookRuntimeError({
          reason: "runtime-unavailable",
          message: "The local notebook runtime is unavailable.",
        });
      case "invalid-sequence":
        return new NotebookRuntimeError({
          reason: "runtime-protocol",
          message: "The notebook runtime returned an invalid event sequence.",
        });
      case "command-id-conflict":
      case "invalid-mount":
        return new NotebookRuntimeError({
          reason: "command-failed",
          message: "The notebook command was rejected.",
        });
    }
  }
  return new NotebookRuntimeError({
    reason: "command-failed",
    message: "The notebook runtime command failed.",
  });
};

export const makeNotebookRuntimeRpcHandlers = (dependencies: NotebookRuntimeRpcDependencies) => {
  const authorizationError = (requiredScope: AuthEnvironmentScope) =>
    new EnvironmentAuthorizationError({
      message: `The authenticated token is missing required scope: ${requiredScope}.`,
      requiredScope,
    });
  const authorize = <A, E, R>(
    method: NotebookRuntimeRpcMethod,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
    dependencies.scopes.includes(NOTEBOOK_RUNTIME_RPC_SCOPES[method])
      ? effect
      : Effect.fail(authorizationError(NOTEBOOK_RUNTIME_RPC_SCOPES[method]));
  const authorizeStream = <A, E, R>(
    method: NotebookRuntimeRpcMethod,
    stream: Stream.Stream<A, E, R>,
  ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
    dependencies.scopes.includes(NOTEBOOK_RUNTIME_RPC_SCOPES[method])
      ? stream
      : Stream.fail(authorizationError(NOTEBOOK_RUNTIME_RPC_SCOPES[method]));

  const validateScope = Effect.fn("NotebookRuntimeRpc.validateScope")(function* (scope: {
    readonly environmentId: string;
    readonly projectId: ProjectId;
  }) {
    const environmentId = yield* dependencies.environmentId;
    if (scope.environmentId !== environmentId) {
      return yield* new NotebookRuntimeError({
        reason: "scope-mismatch",
        message: "The notebook request is scoped to a different environment.",
      });
    }
    const exists = yield* dependencies.projectExists(scope.projectId).pipe(
      Effect.mapError(
        () =>
          new NotebookRuntimeError({
            reason: "runtime-unavailable",
            message: "Could not validate the notebook project scope.",
          }),
      ),
    );
    if (!exists) {
      return yield* new NotebookRuntimeError({
        reason: "project-not-found",
        message: "The notebook project does not exist in this environment.",
      });
    }
  });

  const promise = <A>(thunk: () => Promise<A>) =>
    Effect.tryPromise({ try: thunk, catch: runtimeFailure });

  const control = (
    method:
      | typeof WS_METHODS.notebookExecutionInterrupt
      | typeof WS_METHODS.notebookKernelRestart
      | typeof WS_METHODS.notebookSessionDispose,
    input: NotebookExecutionControlInput,
  ) =>
    authorize(
      method,
      Effect.gen(function* () {
        yield* validateScope(input.scope);
        const command = {
          projectId: input.scope.projectId,
          sessionId: input.sessionId,
          commandId: input.commandId,
        };
        return yield* promise(() =>
          method === WS_METHODS.notebookExecutionInterrupt
            ? dependencies.manager.interrupt(command)
            : method === WS_METHODS.notebookKernelRestart
              ? dependencies.manager.restart(command)
              : dependencies.manager.dispose(command),
        );
      }),
    );

  return {
    [WS_METHODS.notebookSessionOpen]: (input: NotebookSessionOpenInput) =>
      authorize(
        WS_METHODS.notebookSessionOpen,
        Effect.gen(function* () {
          yield* validateScope(input.scope);
          return yield* promise(() =>
            dependencies.manager.open({
              projectId: input.scope.projectId,
              sessionId: input.sessionId,
              commandId: input.commandId,
              kernelName: input.kernelName,
            }),
          );
        }),
      ),
    [WS_METHODS.notebookCellExecute]: (input: NotebookCellExecuteInput) =>
      authorizeStream(
        WS_METHODS.notebookCellExecute,
        Stream.unwrap(
          validateScope(input.scope).pipe(
            Effect.map(() =>
              Stream.fromAsyncIterable(
                dependencies.manager.execute({
                  projectId: input.scope.projectId,
                  sessionId: input.sessionId,
                  commandId: input.commandId,
                  executionId: input.executionId,
                  cellId: input.cellId,
                  code: input.code,
                }),
                runtimeFailure,
              ),
            ),
          ),
        ),
      ),
    [WS_METHODS.notebookExecutionInterrupt]: (input: NotebookExecutionControlInput) =>
      control(WS_METHODS.notebookExecutionInterrupt, input),
    [WS_METHODS.notebookKernelRestart]: (input: NotebookExecutionControlInput) =>
      control(WS_METHODS.notebookKernelRestart, input),
    [WS_METHODS.notebookSessionDispose]: (input: NotebookExecutionControlInput) =>
      control(WS_METHODS.notebookSessionDispose, input),
    [WS_METHODS.notebookSessionEvents]: (input: NotebookSessionEventsInput) =>
      authorize(
        WS_METHODS.notebookSessionEvents,
        Effect.gen(function* () {
          yield* validateScope(input.scope);
          return yield* Effect.try({
            try: () =>
              dependencies.manager.eventsAfter(
                input.scope.projectId,
                input.sessionId,
                input.afterSequence,
              ),
            catch: runtimeFailure,
          });
        }),
      ),
  };
};
