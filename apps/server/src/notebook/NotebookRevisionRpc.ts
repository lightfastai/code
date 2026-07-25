import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type NotebookRevisionCreateInput,
  type NotebookRevisionImportInput,
  type NotebookRevisionRef,
  type NotebookRevisionSaveInput,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import { NotebookRevisionError } from "@t3tools/lightfast-artifact-notebook/contracts";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import type { NotebookRevisionStoreShape } from "./NotebookRevisionStore.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export type NotebookRevisionRpcMethod =
  | typeof WS_METHODS.notebookRevisionCreate
  | typeof WS_METHODS.notebookRevisionRead
  | typeof WS_METHODS.notebookRevisionSave
  | typeof WS_METHODS.notebookRevisionImport
  | typeof WS_METHODS.notebookRevisionExport;

export const NOTEBOOK_REVISION_RPC_SCOPES = {
  [WS_METHODS.notebookRevisionCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.notebookRevisionRead]: AuthOrchestrationReadScope,
  [WS_METHODS.notebookRevisionSave]: AuthOrchestrationOperateScope,
  [WS_METHODS.notebookRevisionImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.notebookRevisionExport]: AuthOrchestrationReadScope,
} as const satisfies Record<NotebookRevisionRpcMethod, AuthEnvironmentScope>;

export type ObserveNotebookRevisionRpcEffect = <A, E, R>(
  method: NotebookRevisionRpcMethod,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

export interface NotebookRevisionRpcDependencies {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly environmentId: Effect.Effect<EnvironmentId>;
  readonly projectExists: (
    projectId: ProjectId,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly randomUUID: Effect.Effect<string, PlatformError.PlatformError>;
  readonly store: NotebookRevisionStoreShape;
  readonly observe?: ObserveNotebookRevisionRpcEffect;
}

const identityObserver: ObserveNotebookRevisionRpcEffect = (_method, effect) => effect;

export const makeNotebookRevisionRpcHandlers = (dependencies: NotebookRevisionRpcDependencies) => {
  const observe = dependencies.observe ?? identityObserver;
  const authorizationError = (requiredScope: AuthEnvironmentScope) =>
    new EnvironmentAuthorizationError({
      message: `The authenticated token is missing required scope: ${requiredScope}.`,
      requiredScope,
    });
  const authorize = <A, E, R>(
    method: NotebookRevisionRpcMethod,
    effect: Effect.Effect<A, E, R>,
  ) => {
    const authorized: Effect.Effect<A, E | EnvironmentAuthorizationError, R> =
      dependencies.scopes.includes(NOTEBOOK_REVISION_RPC_SCOPES[method])
        ? effect
        : Effect.fail(authorizationError(NOTEBOOK_REVISION_RPC_SCOPES[method]));
    return observe(method, authorized);
  };
  const validateScope = Effect.fn("NotebookRevisionRpc.validateScope")(function* (scope: {
    readonly environmentId: string;
    readonly projectId: ProjectId;
  }) {
    const environmentId = yield* dependencies.environmentId;
    if (scope.environmentId !== environmentId) {
      return yield* new NotebookRevisionError({
        reason: "scope-mismatch",
        message: "The notebook request is scoped to a different environment.",
      });
    }
    const projectExists = yield* dependencies.projectExists(scope.projectId).pipe(
      Effect.mapError(
        () =>
          new NotebookRevisionError({
            reason: "storage-failed",
            message: "Could not validate the notebook project scope.",
          }),
      ),
    );
    if (!projectExists) {
      return yield* new NotebookRevisionError({
        reason: "project-not-found",
        message: "The notebook project does not exist in this environment.",
      });
    }
  });

  return {
    [WS_METHODS.notebookRevisionCreate]: (input: NotebookRevisionCreateInput) =>
      authorize(
        WS_METHODS.notebookRevisionCreate,
        Effect.gen(function* () {
          yield* validateScope(input.scope);
          const documentUuid = yield* dependencies.randomUUID.pipe(
            Effect.mapError(
              () =>
                new NotebookRevisionError({
                  reason: "storage-failed",
                  message: "Could not generate a notebook document ID.",
                }),
            ),
          );
          return yield* dependencies.store.save({
            scope: input.scope,
            documentId: `notebook-${documentUuid}`,
            notebook: {
              nbformat: 4,
              nbformat_minor: 5,
              metadata: {
                kernelspec: {
                  name: input.kernel.name,
                  display_name: input.kernel.displayName,
                  language: input.kernel.language,
                },
                ...(input.title === undefined ? {} : { lightfast: { title: input.title } }),
              },
              cells: [],
            },
          });
        }),
      ),
    [WS_METHODS.notebookRevisionRead]: (input: NotebookRevisionRef) =>
      authorize(
        WS_METHODS.notebookRevisionRead,
        Effect.gen(function* () {
          yield* validateScope(input.scope);
          return yield* dependencies.store.read(input);
        }),
      ),
    [WS_METHODS.notebookRevisionSave]: (input: NotebookRevisionSaveInput) =>
      authorize(
        WS_METHODS.notebookRevisionSave,
        Effect.gen(function* () {
          yield* validateScope(input.scope);
          return yield* dependencies.store.save({
            scope: input.scope,
            documentId: input.documentId,
            notebook: input.document,
          });
        }),
      ),
    [WS_METHODS.notebookRevisionImport]: (input: NotebookRevisionImportInput) =>
      authorize(
        WS_METHODS.notebookRevisionImport,
        Effect.gen(function* () {
          yield* validateScope(input.scope);
          return yield* dependencies.store.importIpynb(input);
        }),
      ),
    [WS_METHODS.notebookRevisionExport]: (input: NotebookRevisionRef) =>
      authorize(
        WS_METHODS.notebookRevisionExport,
        Effect.gen(function* () {
          yield* validateScope(input.scope);
          return {
            fileName: `notebook-${input.documentId.slice(0, 128)}.ipynb`,
            contentType: "application/x-ipynb+json" as const,
            ipynbJson: yield* dependencies.store.exportIpynb(input),
          };
        }),
      ),
  };
};
