import * as Schema from "effect/Schema";

export const NOTEBOOK_NBFORMAT_MAJOR = 4 as const;
export const NOTEBOOK_NBFORMAT_MINOR = 5 as const;
export const NOTEBOOK_MAX_CELLS = 1_000;
export const NOTEBOOK_CELL_SOURCE_MAX_BYTES = 1024 * 1024;
export const NOTEBOOK_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
export const NOTEBOOK_MAX_OUTPUTS_PER_CELL = 1_000;
export const NOTEBOOK_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const ShortNonEmptyString = NonEmptyString.check(Schema.isMaxLength(255));

export const NotebookDocumentId = NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
export type NotebookDocumentId = typeof NotebookDocumentId.Type;

export const NotebookRevisionId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type NotebookRevisionId = typeof NotebookRevisionId.Type;

export const NotebookContentHash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type NotebookContentHash = typeof NotebookContentHash.Type;

export const NotebookCellId = NonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
export type NotebookCellId = typeof NotebookCellId.Type;

export const NotebookKernel = Schema.Struct({
  name: ShortNonEmptyString,
  displayName: ShortNonEmptyString,
  language: ShortNonEmptyString,
});
export type NotebookKernel = typeof NotebookKernel.Type;

export const NotebookLightfastMetadata = Schema.Struct({
  title: Schema.optional(ShortNonEmptyString),
  sourceDocumentId: Schema.optional(NotebookDocumentId),
});
export type NotebookLightfastMetadata = typeof NotebookLightfastMetadata.Type;

export const NotebookCellMetadata = Schema.Struct({
  collapsed: Schema.optional(Schema.Boolean),
  scrolled: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("auto")])),
  tags: Schema.optional(Schema.Array(ShortNonEmptyString).check(Schema.isMaxLength(64))),
  jupyter: Schema.optional(
    Schema.Struct({
      sourceHidden: Schema.optional(Schema.Boolean),
      outputsHidden: Schema.optional(Schema.Boolean),
    }),
  ),
  lightfast: Schema.optional(
    Schema.Struct({
      locked: Schema.optional(Schema.Boolean),
      role: Schema.optional(ShortNonEmptyString),
    }),
  ),
});
export type NotebookCellMetadata = typeof NotebookCellMetadata.Type;

export const NotebookMimeBundle = Schema.Struct({
  "text/plain": Schema.optional(Schema.String),
  "text/markdown": Schema.optional(Schema.String),
  "text/html": Schema.optional(Schema.String),
  "image/png": Schema.optional(Schema.String),
  "image/svg+xml": Schema.optional(Schema.String),
  "application/json": Schema.optional(Schema.Json),
  "application/vnd.dataresource+json": Schema.optional(Schema.Json),
  "application/vnd.plotly.v1+json": Schema.optional(Schema.Json),
  "application/vnd.vega.v5+json": Schema.optional(Schema.Json),
  "application/vnd.vegalite.v5+json": Schema.optional(Schema.Json),
});
export type NotebookMimeBundle = typeof NotebookMimeBundle.Type;

export const NotebookStreamOutput = Schema.Struct({
  output_type: Schema.Literal("stream"),
  name: Schema.Literals(["stdout", "stderr"]),
  text: Schema.String,
});

export const NotebookDisplayOutput = Schema.Struct({
  output_type: Schema.Literal("display_data"),
  data: NotebookMimeBundle,
  metadata: Schema.Struct({}),
});

export const NotebookExecutionResultOutput = Schema.Struct({
  output_type: Schema.Literal("execute_result"),
  execution_count: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  data: NotebookMimeBundle,
  metadata: Schema.Struct({}),
});

export const NotebookErrorOutput = Schema.Struct({
  output_type: Schema.Literal("error"),
  ename: Schema.String,
  evalue: Schema.String,
  traceback: Schema.Array(Schema.String).check(Schema.isMaxLength(1_000)),
});

export const NotebookOutput = Schema.Union([
  NotebookStreamOutput,
  NotebookDisplayOutput,
  NotebookExecutionResultOutput,
  NotebookErrorOutput,
]);
export type NotebookOutput = typeof NotebookOutput.Type;

export const NotebookMarkdownCell = Schema.Struct({
  cell_type: Schema.Literal("markdown"),
  id: NotebookCellId,
  metadata: NotebookCellMetadata,
  source: Schema.String,
});

export const NotebookCodeCell = Schema.Struct({
  cell_type: Schema.Literal("code"),
  id: NotebookCellId,
  metadata: NotebookCellMetadata,
  source: Schema.String,
  execution_count: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  outputs: Schema.Array(NotebookOutput).check(Schema.isMaxLength(NOTEBOOK_MAX_OUTPUTS_PER_CELL)),
});

export const NotebookCell = Schema.Union([NotebookMarkdownCell, NotebookCodeCell]);
export type NotebookCell = typeof NotebookCell.Type;

export const NotebookDocument = Schema.Struct({
  nbformat: Schema.Literal(NOTEBOOK_NBFORMAT_MAJOR),
  nbformat_minor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  metadata: Schema.Struct({
    kernelspec: Schema.Struct({
      name: ShortNonEmptyString,
      display_name: ShortNonEmptyString,
      language: ShortNonEmptyString,
    }),
    lightfast: Schema.optional(NotebookLightfastMetadata),
  }),
  cells: Schema.Array(NotebookCell).check(Schema.isMaxLength(NOTEBOOK_MAX_CELLS)),
});
export type NotebookDocument = typeof NotebookDocument.Type;

export const NotebookRevision = Schema.Struct({
  documentId: NotebookDocumentId,
  revisionId: NotebookRevisionId,
  contentHash: NotebookContentHash,
  kernel: NotebookKernel,
  document: NotebookDocument,
  createdAt: Schema.String,
});
export type NotebookRevision = typeof NotebookRevision.Type;

export const NotebookInitialView = Schema.Struct({
  mode: Schema.Literals(["notebook", "cell"]),
  cellId: Schema.optional(NotebookCellId),
});
export type NotebookInitialView = typeof NotebookInitialView.Type;

export const NotebookArtifactPayload = Schema.Struct({
  documentId: NotebookDocumentId,
  revisionId: NotebookRevisionId,
  contentHash: NotebookContentHash,
  kernel: NotebookKernel,
  initialView: NotebookInitialView,
});
export type NotebookArtifactPayload = typeof NotebookArtifactPayload.Type;

export class NotebookRevisionError extends Schema.TaggedErrorClass<NotebookRevisionError>()(
  "NotebookRevisionError",
  {
    reason: Schema.Literals([
      "invalid-notebook",
      "limit-exceeded",
      "hash-failed",
      "not-found",
      "content-hash-mismatch",
      "immutable-conflict",
      "scope-mismatch",
      "project-not-found",
      "storage-failed",
    ]),
    message: Schema.String,
  },
) {}
