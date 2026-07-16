import {
  NOTEBOOK_DOCUMENT_MAX_BYTES,
  NotebookDocument,
  NotebookDocumentId,
  NotebookKernel,
  NotebookRevision,
  NotebookRevisionId,
} from "@t3tools/lightfast-artifact-notebook/contracts";
import * as Schema from "effect/Schema";

import { ScopedProjectRef } from "./environment.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

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
