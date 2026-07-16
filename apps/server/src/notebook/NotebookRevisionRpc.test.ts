import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type NotebookRevision,
  type NotebookRevisionExportResult,
  ProjectId,
  WS_METHODS,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import {
  NotebookContentHash,
  NotebookDocumentId,
  NotebookRevisionId,
  NotebookRevisionError,
} from "@t3tools/lightfast-artifact-notebook/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { NotebookRevisionStoreShape } from "./NotebookRevisionStore.ts";
import { makeNotebookRevisionRpcHandlers } from "./NotebookRevisionRpc.ts";

const environmentId = EnvironmentId.make("environment-notebook-rpc");
const projectId = ProjectId.make("project-notebook-rpc");
const otherEnvironmentId = EnvironmentId.make("environment-other");
const otherProjectId = ProjectId.make("project-other");
const documentId = NotebookDocumentId.make("document-rpc");
const revisionId = NotebookRevisionId.make("a".repeat(64));
const contentHash = NotebookContentHash.make(revisionId);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const document = {
  nbformat: 4 as const,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
  },
  cells: [],
};
const revision = {
  documentId,
  revisionId,
  contentHash,
  kernel: { name: "python3", displayName: "Python 3", language: "python" },
  document,
  createdAt: "2026-07-16T00:00:00.000Z",
};

type NotebookMethod =
  | typeof WS_METHODS.notebookRevisionCreate
  | typeof WS_METHODS.notebookRevisionRead
  | typeof WS_METHODS.notebookRevisionSave
  | typeof WS_METHODS.notebookRevisionImport
  | typeof WS_METHODS.notebookRevisionExport;

const methods = [
  { method: WS_METHODS.notebookRevisionCreate, scope: AuthOrchestrationOperateScope },
  { method: WS_METHODS.notebookRevisionRead, scope: AuthOrchestrationReadScope },
  { method: WS_METHODS.notebookRevisionSave, scope: AuthOrchestrationOperateScope },
  { method: WS_METHODS.notebookRevisionImport, scope: AuthOrchestrationOperateScope },
  { method: WS_METHODS.notebookRevisionExport, scope: AuthOrchestrationReadScope },
] as const;

const makeHarness = (options?: {
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly currentEnvironmentId?: EnvironmentId;
  readonly projectExists?: (candidate: ProjectId) => boolean;
}) => {
  const calls: Array<{ readonly operation: string; readonly scope: unknown }> = [];
  const store: NotebookRevisionStoreShape = {
    save: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "save", scope: input.scope });
        return revision;
      }),
    read: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "read", scope: input.scope });
        return revision;
      }),
    importIpynb: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "import", scope: input.scope });
        return revision;
      }),
    exportIpynb: (input) =>
      Effect.sync(() => {
        calls.push({ operation: "export", scope: input.scope });
        return encodeUnknownJson(document);
      }),
  };
  const handlers = makeNotebookRevisionRpcHandlers({
    scopes: options?.scopes ?? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    environmentId: Effect.succeed(options?.currentEnvironmentId ?? environmentId),
    projectExists: (candidate) =>
      Effect.succeed(options?.projectExists?.(candidate) ?? candidate === projectId),
    randomUUID: Effect.succeed("00000000-0000-4000-8000-000000000000"),
    store,
  });
  return { calls, handlers };
};

const invoke = (
  handlers: ReturnType<typeof makeNotebookRevisionRpcHandlers>,
  method: NotebookMethod,
  scope = { environmentId, projectId },
): Effect.Effect<
  NotebookRevision | NotebookRevisionExportResult,
  NotebookRevisionError | EnvironmentAuthorizationError
> => {
  switch (method) {
    case WS_METHODS.notebookRevisionCreate:
      return handlers[method]({
        scope,
        kernel: { name: "python3", displayName: "Python 3", language: "python" },
      });
    case WS_METHODS.notebookRevisionRead:
      return handlers[method]({ scope, documentId, revisionId });
    case WS_METHODS.notebookRevisionSave:
      return handlers[method]({ scope, documentId, document });
    case WS_METHODS.notebookRevisionImport:
      return handlers[method]({ scope, ipynbJson: encodeUnknownJson(document) });
    case WS_METHODS.notebookRevisionExport:
      return handlers[method]({ scope, documentId, revisionId });
  }
};

describe("NotebookRevisionRpc", () => {
  it.effect("enforces read versus operate authorization for all five handlers", () =>
    Effect.gen(function* () {
      for (const { method, scope } of methods) {
        const authorized = makeHarness({ scopes: [scope] });
        yield* invoke(authorized.handlers, method);
        assert.lengthOf(authorized.calls, 1);

        const denied = makeHarness({
          scopes: [
            scope === AuthOrchestrationReadScope
              ? AuthOrchestrationOperateScope
              : AuthOrchestrationReadScope,
          ],
        });
        const error = yield* Effect.flip(invoke(denied.handlers, method));
        assert.strictEqual(
          (error as { readonly _tag?: string })._tag,
          "EnvironmentAuthorizationError",
        );
        assert.strictEqual((error as { readonly requiredScope?: string }).requiredScope, scope);
        assert.lengthOf(denied.calls, 0);
      }
    }),
  );

  it.effect("rejects environment mismatch before every store operation", () =>
    Effect.gen(function* () {
      for (const { method, scope } of methods) {
        const harness = makeHarness({ scopes: [scope] });
        const error = yield* Effect.flip(
          invoke(harness.handlers, method, { environmentId: otherEnvironmentId, projectId }),
        );
        assert.strictEqual((error as { readonly reason?: string }).reason, "scope-mismatch");
        assert.lengthOf(harness.calls, 0);
      }
    }),
  );

  it.effect("rejects a missing project before every store operation", () =>
    Effect.gen(function* () {
      for (const { method, scope } of methods) {
        const harness = makeHarness({ scopes: [scope], projectExists: () => false });
        const error = yield* Effect.flip(invoke(harness.handlers, method));
        assert.strictEqual((error as { readonly reason?: string }).reason, "project-not-found");
        assert.lengthOf(harness.calls, 0);
      }
    }),
  );

  it.effect("keeps store calls isolated to the validated environment and project", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ projectExists: (candidate) => candidate === projectId });
      for (const { method } of methods) yield* invoke(harness.handlers, method);

      assert.lengthOf(harness.calls, methods.length);
      for (const call of harness.calls) {
        assert.deepStrictEqual(call.scope, { environmentId, projectId });
      }

      for (const { method } of methods) {
        const error = yield* Effect.flip(
          invoke(harness.handlers, method, { environmentId, projectId: otherProjectId }),
        );
        assert.strictEqual((error as { readonly reason?: string }).reason, "project-not-found");
      }
      assert.lengthOf(harness.calls, methods.length);
    }),
  );
});
