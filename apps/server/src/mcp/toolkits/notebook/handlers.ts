import * as NodeCrypto from "node:crypto";

import {
  ArtifactPublishError,
  CommandId,
  MessageId,
  NotebookAgentToolError,
  type NotebookAgentExecuteAllInput,
  type NotebookAgentExecuteCellInput,
  type PublishNotebookArtifactInput,
  type PublishNotebookArtifactResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { narrowStudyDocumentIds } from "@t3tools/shared/studyContext";

import * as ServerConfig from "../../../config.ts";
import { lightfastServerCapabilities } from "../../../lightfast/register.ts";
import { makeNotebookAgentTools } from "../../../notebook/NotebookAgentTools.ts";
import { NotebookRevisionStore } from "../../../notebook/NotebookRevisionStore.ts";
import { NOTEBOOK_RUNTIME_KERNEL_LOCK_HASH } from "../../../notebook/NotebookRuntimeIdentity.ts";
import { NotebookRuntimeManagerService } from "../../../notebook/NotebookRuntimeManager.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  resolveStudyDocumentMountPaths,
  resolveStudyLibraryPaths,
} from "../../../study/StudyLibrary.ts";
import {
  resolveStudyLoopPaths,
  studyTracePath,
  writeStudyTraceFile,
} from "../../../study/StudyTraceStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import { NotebookToolkit } from "./tools.ts";

const publicationError = (): ArtifactPublishError =>
  new ArtifactPublishError({ message: "The notebook artifact could not be published." });

const executionError = (
  reason: NotebookAgentToolError["reason"],
  message: string,
): NotebookAgentToolError => new NotebookAgentToolError({ reason, message });

const requireThreadProject = Effect.fn("NotebookToolkit.requireThreadProject")(function* (input: {
  readonly environmentId: string;
  readonly projectId: string;
}) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (input.environmentId !== invocation.environmentId) {
    return yield* executionError(
      "scope-mismatch",
      "The notebook request belongs to a different environment.",
    );
  }
  const projections = yield* ProjectionSnapshotQuery;
  const thread = yield* projections
    .getThreadShellById(invocation.threadId)
    .pipe(
      Effect.mapError(() =>
        executionError("scope-mismatch", "The notebook thread scope could not be verified."),
      ),
    );
  if (Option.isNone(thread) || thread.value.projectId !== input.projectId) {
    return yield* executionError(
      "scope-mismatch",
      "The notebook request does not belong to this thread's project.",
    );
  }
  return invocation;
});

export const publishNotebook = Effect.fn("NotebookToolkit.publishNotebook")(function* (
  input: PublishNotebookArtifactInput,
) {
  const invocation = yield* McpInvocationContext.requireArtifactCapability();
  yield* requireThreadProject(input.scope).pipe(Effect.mapError(() => publicationError()));
  const documentIds = narrowStudyDocumentIds(
    invocation.notebookDocumentIds ?? [],
    input.documentIds,
  );
  if (documentIds === null) {
    return yield* publicationError();
  }
  const store = yield* NotebookRevisionStore;
  const revision = yield* store.read(input).pipe(Effect.mapError(() => publicationError()));
  const orchestration = yield* OrchestrationEngineService;
  const id = NodeCrypto.randomUUID();
  const artifactId = `artifact-${id}`;
  const messageId = `artifact-message-${id}`;
  const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const artifact = yield* lightfastServerCapabilities.artifactRegistry
    .decodeForPublication(
      lightfastServerCapabilities.notebook.makeArtifact({
        id: artifactId,
        title: input.title ?? revision.document.metadata.lightfast?.title ?? "Notebook",
        payload: {
          documentId: revision.documentId,
          revisionId: revision.revisionId,
          contentHash: revision.contentHash,
          kernel: revision.kernel,
          initialView: input.initialView,
          documentIds,
        },
      }),
    )
    .pipe(Effect.mapError(() => publicationError()));

  yield* orchestration
    .dispatch({
      type: "thread.message.artifact.publish",
      commandId: CommandId.make(`artifact-command-${id}`),
      threadId: invocation.threadId,
      messageId: MessageId.make(messageId),
      artifact: artifact.artifact,
      createdAt,
    })
    .pipe(Effect.mapError(() => publicationError()));

  return { artifactId, messageId } satisfies PublishNotebookArtifactResult;
});

const withAgentTools = Effect.fn("NotebookToolkit.withAgentTools")(function* <A>(
  operation: (
    tools: ReturnType<typeof makeNotebookAgentTools>,
  ) => Effect.Effect<A, NotebookAgentToolError>,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const sessions = yield* McpSessionRegistry.McpSessionRegistry;
  const store = yield* NotebookRevisionStore;
  const runtime = yield* NotebookRuntimeManagerService;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const libraryPaths = yield* resolveStudyLibraryPaths(config.studyLibraryDir).pipe(
    Effect.mapError(() => executionError("trace-failed", "The study trace path is unavailable.")),
  );
  const loopPaths = yield* resolveStudyLoopPaths(libraryPaths).pipe(
    Effect.mapError(() => executionError("trace-failed", "The study trace path is unavailable.")),
  );
  const tools = makeNotebookAgentTools({
    revisionStore: store,
    runtimeManager: runtime,
    resolveBookPaths: (documentIds) =>
      resolveStudyDocumentMountPaths(libraryPaths, documentIds).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    runtimeIdentity: () =>
      Effect.tryPromise({
        try: () => runtime.resolveRuntimeImageDigest(),
        catch: () => executionError("runtime-unavailable", "The runtime image is unavailable."),
      }).pipe(
        Effect.map((imageDigest) => ({
          imageDigest,
          kernelLockHash: NOTEBOOK_RUNTIME_KERNEL_LOCK_HASH,
        })),
      ),
    withExecutionStart: (scope, documentIds, start) =>
      sessions.withNotebookExecutionStart(scope, documentIds, start),
    writeTrace: (runId, records) =>
      Effect.gen(function* () {
        const tracePath = yield* studyTracePath(loopPaths, runId);
        yield* writeStudyTraceFile({ tracePath, records });
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(() =>
          executionError("trace-failed", "The notebook execution trace could not be persisted."),
        ),
      ),
    randomUUID: NodeCrypto.randomUUID,
    now: Date.now,
  });
  return yield* operation(tools).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
  );
});

const executeCell = (input: NotebookAgentExecuteCellInput) =>
  Effect.gen(function* () {
    const invocation = yield* requireThreadProject(input.scope);
    return yield* withAgentTools((tools) => tools.executeCell(input, invocation));
  });

const executeAll = (input: NotebookAgentExecuteAllInput) =>
  Effect.gen(function* () {
    const invocation = yield* requireThreadProject(input.scope);
    return yield* withAgentTools((tools) => tools.executeAll(input, invocation));
  });

export const NotebookToolkitHandlersLive = NotebookToolkit.toLayer({
  artifact_publish_notebook: publishNotebook,
  notebook_execute_cell: executeCell,
  notebook_execute_all: executeAll,
});
