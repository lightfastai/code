import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const StudyDocumentId = TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type StudyDocumentId = typeof StudyDocumentId.Type;

export const StudyDocumentFormat = Schema.Literals(["pdf", "epub", "markdown"]);
export type StudyDocumentFormat = typeof StudyDocumentFormat.Type;

export const StudyTag = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type StudyTag = typeof StudyTag.Type;

export const StudyDocument = Schema.Struct({
  id: StudyDocumentId,
  sha256: StudyDocumentId,
  format: StudyDocumentFormat,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  objectKey: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  sizeBytes: NonNegativeInt,
  tags: Schema.Array(StudyTag).check(Schema.isMaxLength(64)),
  importedAt: IsoDateTime,
});
export type StudyDocument = typeof StudyDocument.Type;

export const StudyLibraryIndex = Schema.Struct({
  version: Schema.Literal(1),
  documents: Schema.Array(StudyDocument),
});
export type StudyLibraryIndex = typeof StudyLibraryIndex.Type;

const NormalizedRect = Schema.Struct({
  x: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  y: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  width: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  height: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

export const StudyCanvasId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type StudyCanvasId = typeof StudyCanvasId.Type;

export const StudyCanvasRegion = Schema.Struct({
  x: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  y: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  width: Schema.Number.check(Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isGreaterThan(0)),
});
export type StudyCanvasRegion = typeof StudyCanvasRegion.Type;

export const StudyCanvasAnchor = Schema.Struct({
  type: Schema.Literal("canvas-region"),
  rect: StudyCanvasRegion,
  revision: NonNegativeInt,
});
export type StudyCanvasAnchor = typeof StudyCanvasAnchor.Type;

export const StudyDocumentAnchor = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pdf-page"),
    page: PositiveInt,
    rect: Schema.optional(NormalizedRect),
  }),
  Schema.Struct({
    type: Schema.Literal("epub-cfi"),
    cfi: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  }),
  Schema.Struct({
    type: Schema.Literal("epub-spine"),
    href: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
    spineIndex: NonNegativeInt,
    fragment: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  }),
  Schema.Struct({
    type: Schema.Literal("markdown-heading"),
    headingPath: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(512))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16),
    ),
    blockId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  }),
]);
export type StudyDocumentAnchor = typeof StudyDocumentAnchor.Type;

export const StudyDocumentContextSelection = Schema.Struct({
  documentId: StudyDocumentId,
  anchor: StudyDocumentAnchor,
  excerpt: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
});
export type StudyDocumentContextSelection = typeof StudyDocumentContextSelection.Type;

export const StudyCanvasContextSelection = Schema.Struct({
  canvasId: StudyCanvasId,
  anchor: StudyCanvasAnchor,
  snapshotName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type StudyCanvasContextSelection = typeof StudyCanvasContextSelection.Type;

export const StudyContextSelection = Schema.Union([
  StudyDocumentContextSelection,
  StudyCanvasContextSelection,
]);
export type StudyContextSelection = typeof StudyContextSelection.Type;

export const StudyContextCapsule = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128), Schema.isPattern(/^[a-z0-9_-]+$/i)),
  selections: Schema.Array(StudyContextSelection).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
  createdAt: IsoDateTime,
});
export type StudyContextCapsule = typeof StudyContextCapsule.Type;

export const STUDY_EXTRACTED_MAX_SEGMENTS = 4_096;
export const STUDY_EXTRACTED_MAX_SEGMENT_CHARACTERS = 1_000_000;
export const STUDY_EXTRACTED_MAX_UTF8_BYTES = 16 * 1_024 * 1_024;

export const StudyTextSegment = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(160), Schema.isPattern(/^[a-z0-9_-]+$/i)),
  order: NonNegativeInt,
  heading: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  anchor: StudyDocumentAnchor,
  text: Schema.String.check(Schema.isMaxLength(STUDY_EXTRACTED_MAX_SEGMENT_CHARACTERS)),
});
export type StudyTextSegment = typeof StudyTextSegment.Type;

export const StudyExtractedDocument = Schema.Struct({
  version: Schema.Literal(1),
  documentId: StudyDocumentId,
  segments: Schema.Array(StudyTextSegment).check(Schema.isMaxLength(STUDY_EXTRACTED_MAX_SEGMENTS)),
  extractedAt: IsoDateTime,
});
export type StudyExtractedDocument = typeof StudyExtractedDocument.Type;

export const StudyLibraryListInput = Schema.Struct({
  tags: Schema.optional(Schema.Array(StudyTag).check(Schema.isMaxLength(16))),
});
export type StudyLibraryListInput = typeof StudyLibraryListInput.Type;

export const StudyLibraryListResult = Schema.Array(StudyDocument);
export type StudyLibraryListResult = typeof StudyLibraryListResult.Type;

export const StudySearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  documentIds: Schema.optional(Schema.Array(StudyDocumentId).check(Schema.isMaxLength(32))),
  tags: Schema.optional(Schema.Array(StudyTag).check(Schema.isMaxLength(16))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type StudySearchInput = typeof StudySearchInput.Type;

export const StudySearchHit = Schema.Struct({
  documentId: StudyDocumentId,
  documentTitle: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  documentFormat: StudyDocumentFormat,
  anchor: StudyDocumentAnchor,
  heading: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  excerpt: Schema.String.check(Schema.isMaxLength(4_000)),
  score: Schema.Number,
});
export type StudySearchHit = typeof StudySearchHit.Type;

export const StudySearchResult = Schema.Array(StudySearchHit);
export type StudySearchResult = typeof StudySearchResult.Type;

export class StudyToolError extends Schema.TaggedErrorClass<StudyToolError>()("StudyToolError", {
  message: Schema.String,
}) {}

export class StudyLibraryRequestError extends Schema.TaggedErrorClass<StudyLibraryRequestError>()(
  "StudyLibraryRequestError",
  {
    operation: Schema.Literals(["list", "search"]),
    message: Schema.String,
  },
) {}

export const StudyVoiceSessionInput = Schema.Struct({
  documentIds: Schema.optional(Schema.Array(StudyDocumentId).check(Schema.isMaxLength(32))),
});
export type StudyVoiceSessionInput = typeof StudyVoiceSessionInput.Type;

export const StudyVoiceSessionResult = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  token: TrimmedNonEmptyString,
  roomName: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  expiresAt: IsoDateTime,
});
export type StudyVoiceSessionResult = typeof StudyVoiceSessionResult.Type;

export class StudyVoiceSessionError extends Schema.TaggedErrorClass<StudyVoiceSessionError>()(
  "StudyVoiceSessionError",
  {
    reason: Schema.Literals(["not-configured", "invalid-configuration", "library", "token"]),
    message: Schema.String,
  },
) {}
