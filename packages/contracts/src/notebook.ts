import {
  NOTEBOOK_DOCUMENT_MAX_BYTES,
  NotebookCellId,
  NotebookContentHash,
  NotebookInitialView,
  NotebookMimeBundle,
  NotebookDocument,
  NotebookDocumentId,
  NotebookKernel,
  NotebookRevision,
  NotebookRevisionId,
} from "@t3tools/lightfast-artifact-notebook/contracts";
import * as Schema from "effect/Schema";

import { ScopedProjectRef } from "./environment.ts";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SelectedStudyDocumentIds } from "./study.ts";

const NotebookRuntimeIdentifier = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export const NotebookSessionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export type NotebookSessionId = typeof NotebookSessionId.Type;
export const NotebookCommandId = NotebookRuntimeIdentifier;
export type NotebookCommandId = typeof NotebookCommandId.Type;
export const NotebookExecutionId = NotebookRuntimeIdentifier;
export type NotebookExecutionId = typeof NotebookExecutionId.Type;

const NotebookExecutionEventBase = Schema.Struct({
  sessionId: NotebookSessionId,
  commandId: NotebookCommandId,
  sequence: NonNegativeInt,
});
const NotebookExecutionScopedEventBase = Schema.Struct({
  ...NotebookExecutionEventBase.fields,
  executionId: NotebookExecutionId,
  cellId: NotebookCellId,
});
const NotebookLifecycleEventBase = Schema.Struct({
  ...NotebookExecutionEventBase.fields,
  executionId: Schema.optionalKey(Schema.Never),
  cellId: Schema.optionalKey(Schema.Never),
});

export const NotebookExecutionEvent = Schema.Union([
  Schema.Struct({
    ...NotebookLifecycleEventBase.fields,
    type: Schema.Literal("accepted"),
    commandType: Schema.Literals(["open", "interrupt", "restart", "dispose"]),
  }),
  Schema.Struct({
    ...NotebookExecutionScopedEventBase.fields,
    type: Schema.Literal("accepted"),
    commandType: Schema.Literal("execute"),
  }),
  Schema.Struct({
    ...NotebookExecutionScopedEventBase.fields,
    type: Schema.Literal("rejected"),
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  }),
  Schema.Struct({
    ...NotebookLifecycleEventBase.fields,
    type: Schema.Literal("rejected"),
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  }),
  Schema.Struct({
    ...NotebookExecutionScopedEventBase.fields,
    type: Schema.Literal("kernel"),
    state: Schema.Literals(["starting", "busy", "idle", "interrupted", "restarted", "terminated"]),
  }),
  Schema.Struct({
    ...NotebookLifecycleEventBase.fields,
    type: Schema.Literal("kernel"),
    state: Schema.Literals(["starting", "busy", "idle", "interrupted", "restarted", "terminated"]),
  }),
  Schema.Struct({
    ...NotebookExecutionScopedEventBase.fields,
    type: Schema.Literal("execution"),
    executionCount: NonNegativeInt,
  }),
  Schema.Struct({
    ...NotebookExecutionScopedEventBase.fields,
    type: Schema.Literal("stream"),
    name: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
  }),
  Schema.Struct({
    ...NotebookExecutionScopedEventBase.fields,
    type: Schema.Literal("display"),
    data: NotebookMimeBundle,
    metadata: Schema.Json,
  }),
  Schema.Struct({
    ...NotebookExecutionScopedEventBase.fields,
    type: Schema.Literal("result"),
    data: NotebookMimeBundle,
    metadata: Schema.Json,
    executionCount: Schema.NullOr(NonNegativeInt),
  }),
  Schema.Struct({
    ...NotebookExecutionScopedEventBase.fields,
    type: Schema.Literal("error"),
    ename: Schema.String,
    evalue: Schema.String,
    traceback: Schema.Array(Schema.String).check(Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({
    ...NotebookExecutionScopedEventBase.fields,
    type: Schema.Literal("limit"),
    kind: Schema.Literals(["output", "time", "memory", "process", "disk"]),
    limit: Schema.Number.check(Schema.isGreaterThan(0)),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  }),
]);
export type NotebookExecutionEvent = typeof NotebookExecutionEvent.Type;

const NotebookRuntimeSessionRef = Schema.Struct({
  scope: ScopedProjectRef,
  sessionId: NotebookSessionId,
});
const NotebookSelectedStudyDocuments = Schema.Struct({
  documentIds: SelectedStudyDocumentIds,
});

export const NotebookSessionOpenInput = Schema.Struct({
  ...NotebookRuntimeSessionRef.fields,
  ...NotebookSelectedStudyDocuments.fields,
  commandId: NotebookCommandId,
  kernelName: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type NotebookSessionOpenInput = typeof NotebookSessionOpenInput.Type;

export const NotebookCellExecuteInput = Schema.Struct({
  ...NotebookRuntimeSessionRef.fields,
  commandId: NotebookCommandId,
  executionId: NotebookExecutionId,
  cellId: NotebookCellId,
  code: Schema.String.check(Schema.isMaxLength(2 * 1024 * 1024)),
});
export type NotebookCellExecuteInput = typeof NotebookCellExecuteInput.Type;

export const NotebookExecutionControlInput = Schema.Struct({
  ...NotebookRuntimeSessionRef.fields,
  commandId: NotebookCommandId,
});
export type NotebookExecutionControlInput = typeof NotebookExecutionControlInput.Type;

export const NotebookSessionEventsInput = Schema.Struct({
  ...NotebookRuntimeSessionRef.fields,
  afterSequence: NonNegativeInt,
});
export type NotebookSessionEventsInput = typeof NotebookSessionEventsInput.Type;

export const NotebookExecutionEvents = Schema.Array(NotebookExecutionEvent);
export type NotebookExecutionEvents = typeof NotebookExecutionEvents.Type;

export const NotebookExecutionReplay = Schema.Struct({
  baselineSequence: NonNegativeInt,
  events: NotebookExecutionEvents,
});
export type NotebookExecutionReplay = typeof NotebookExecutionReplay.Type;

export class NotebookRuntimeError extends Schema.TaggedErrorClass<NotebookRuntimeError>()(
  "NotebookRuntimeError",
  {
    reason: Schema.Literals([
      "scope-mismatch",
      "project-not-found",
      "session-not-found",
      "runtime-unavailable",
      "runtime-protocol",
      "command-failed",
    ]),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  },
) {}

export const NotebookRevisionRef = Schema.Struct({
  scope: ScopedProjectRef,
  documentId: NotebookDocumentId,
  revisionId: NotebookRevisionId,
});
export type NotebookRevisionRef = typeof NotebookRevisionRef.Type;

export const NotebookAgentExecutionPermission = Schema.Struct({
  threadId: ThreadId,
  allowNotebookExecution: Schema.Boolean,
});
export type NotebookAgentExecutionPermission = typeof NotebookAgentExecutionPermission.Type;

export const NotebookAgentExecutionPermissionGetInput = Schema.Struct({
  threadId: ThreadId,
});
export type NotebookAgentExecutionPermissionGetInput =
  typeof NotebookAgentExecutionPermissionGetInput.Type;

export const NotebookAgentExecutionPermissionSetInput = NotebookAgentExecutionPermission;
export type NotebookAgentExecutionPermissionSetInput =
  typeof NotebookAgentExecutionPermissionSetInput.Type;

export const PublishNotebookArtifactInput = Schema.Struct({
  ...NotebookRevisionRef.fields,
  ...NotebookSelectedStudyDocuments.fields,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  initialView: NotebookInitialView,
});
export type PublishNotebookArtifactInput = typeof PublishNotebookArtifactInput.Type;

export const PublishNotebookArtifactResult = Schema.Struct({
  artifactId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  messageId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type PublishNotebookArtifactResult = typeof PublishNotebookArtifactResult.Type;

export const NotebookAgentExecuteCellInput = Schema.Struct({
  ...NotebookRevisionRef.fields,
  ...NotebookSelectedStudyDocuments.fields,
  cellId: NotebookCellId,
});
export type NotebookAgentExecuteCellInput = typeof NotebookAgentExecuteCellInput.Type;

export const NotebookAgentExecuteAllInput = Schema.Struct({
  ...NotebookRevisionRef.fields,
  ...NotebookSelectedStudyDocuments.fields,
});
export type NotebookAgentExecuteAllInput = typeof NotebookAgentExecuteAllInput.Type;

export const NotebookAgentExecutionResult = Schema.Struct({
  documentId: NotebookDocumentId,
  revisionId: NotebookRevisionId,
  contentHash: NotebookContentHash,
  traceRunId: TrimmedNonEmptyString.check(
    Schema.isMaxLength(160),
    Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/i),
  ),
  outputHash: NotebookContentHash,
  durationMs: NonNegativeInt,
});
export type NotebookAgentExecutionResult = typeof NotebookAgentExecutionResult.Type;

export class NotebookAgentToolError extends Schema.TaggedErrorClass<NotebookAgentToolError>()(
  "NotebookAgentToolError",
  {
    reason: Schema.Literals([
      "permission-denied",
      "scope-mismatch",
      "revision-not-found",
      "cell-not-found",
      "runtime-unavailable",
      "execution-failed",
      "trace-failed",
    ]),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  },
) {}

export const NotebookRevisionCreateInput = Schema.Struct({
  scope: ScopedProjectRef,
  kernel: NotebookKernel,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
});
export type NotebookRevisionCreateInput = typeof NotebookRevisionCreateInput.Type;

export const NotebookRevisionSaveInput = Schema.Struct({
  scope: ScopedProjectRef,
  documentId: NotebookDocumentId,
  document: NotebookDocument,
});
export type NotebookRevisionSaveInput = typeof NotebookRevisionSaveInput.Type;

export const NotebookRevisionImportInput = Schema.Struct({
  scope: ScopedProjectRef,
  ipynbJson: Schema.String.check(Schema.isMaxLength(NOTEBOOK_DOCUMENT_MAX_BYTES)),
});
export type NotebookRevisionImportInput = typeof NotebookRevisionImportInput.Type;

export const NotebookRevisionExportResult = Schema.Struct({
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  contentType: Schema.Literal("application/x-ipynb+json"),
  ipynbJson: Schema.String,
});
export type NotebookRevisionExportResult = typeof NotebookRevisionExportResult.Type;

export { NotebookRevision };
