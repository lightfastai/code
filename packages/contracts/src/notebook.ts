import {
  NOTEBOOK_DOCUMENT_MAX_BYTES,
  NotebookMimeBundle,
  NotebookDocument,
  NotebookDocumentId,
  NotebookKernel,
  NotebookRevision,
  NotebookRevisionId,
} from "@t3tools/lightfast-artifact-notebook/contracts";
import * as Schema from "effect/Schema";

import { ScopedProjectRef } from "./environment.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
});

export const NotebookExecutionEvent = Schema.Union([
  Schema.Struct({
    ...NotebookExecutionEventBase.fields,
    type: Schema.Literal("accepted"),
    executionId: Schema.optional(NotebookExecutionId),
    commandType: Schema.Literals(["open", "execute", "interrupt", "restart", "dispose"]),
  }),
  Schema.Struct({
    ...NotebookExecutionEventBase.fields,
    type: Schema.Literal("rejected"),
    executionId: Schema.optional(NotebookExecutionId),
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
  }),
  Schema.Struct({
    ...NotebookExecutionEventBase.fields,
    type: Schema.Literal("kernel"),
    executionId: Schema.optional(NotebookExecutionId),
    state: Schema.Literals(["starting", "busy", "idle", "interrupted", "restarted", "terminated"]),
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

export const NotebookSessionOpenInput = Schema.Struct({
  ...NotebookRuntimeSessionRef.fields,
  commandId: NotebookCommandId,
  kernelName: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type NotebookSessionOpenInput = typeof NotebookSessionOpenInput.Type;

export const NotebookCellExecuteInput = Schema.Struct({
  ...NotebookRuntimeSessionRef.fields,
  commandId: NotebookCommandId,
  executionId: NotebookExecutionId,
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
