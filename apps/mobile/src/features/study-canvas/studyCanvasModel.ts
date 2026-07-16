import { StudyCanvasId, StudyCanvasRegion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const STUDY_CANVAS_SCHEMA_VERSION = 1;
export const STUDY_CANVAS_MAX_SNAPSHOT_OPERATIONS = 64;

const StudyCanvasSnapshotOperation = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  type: Schema.Literal("drawing-snapshot"),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  snapshotFileName: Schema.String.check(
    Schema.isMaxLength(180),
    Schema.isPattern(/^[a-z0-9._-]+\.drawing$/i),
  ),
  contentBounds: Schema.optional(StudyCanvasRegion),
  createdAt: Schema.String,
});
export type StudyCanvasSnapshotOperation = typeof StudyCanvasSnapshotOperation.Type;

const StudyCanvasMetadata = Schema.Struct({
  id: StudyCanvasId,
  title: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type StudyCanvasMetadata = typeof StudyCanvasMetadata.Type;

export const StudyCanvasDocument = Schema.Struct({
  schemaVersion: Schema.Literal(STUDY_CANVAS_SCHEMA_VERSION),
  canvas: StudyCanvasMetadata,
  operations: Schema.Array(StudyCanvasSnapshotOperation).check(
    Schema.isMaxLength(STUDY_CANVAS_MAX_SNAPSHOT_OPERATIONS),
  ),
});
export type StudyCanvasDocument = typeof StudyCanvasDocument.Type;

const decodeStudyCanvasDocumentSync = Schema.decodeUnknownSync(StudyCanvasDocument);

export function decodeStudyCanvasDocument(value: unknown): StudyCanvasDocument {
  return decodeStudyCanvasDocumentSync(value);
}

export function createStudyCanvasDocument(input: {
  readonly canvasId: string;
  readonly title: string;
  readonly now: string;
}): StudyCanvasDocument {
  return decodeStudyCanvasDocument({
    schemaVersion: STUDY_CANVAS_SCHEMA_VERSION,
    canvas: {
      id: input.canvasId,
      title: input.title.trim(),
      createdAt: input.now,
      updatedAt: input.now,
    },
    operations: [],
  });
}

export function appendStudyCanvasSnapshotOperation(
  document: StudyCanvasDocument,
  input: {
    readonly operationId: string;
    readonly revision: number;
    readonly digest: string;
    readonly snapshotFileName: string;
    readonly contentBounds?: StudyCanvasRegion;
    readonly now: string;
  },
): {
  readonly document: StudyCanvasDocument;
  readonly prunedSnapshotFileNames: ReadonlyArray<string>;
} {
  const previous = document.operations.at(-1);
  if (previous?.digest === input.digest) {
    return { document, prunedSnapshotFileNames: [] };
  }

  const operation: StudyCanvasSnapshotOperation = {
    id: input.operationId,
    sequence: (previous?.sequence ?? 0) + 1,
    type: "drawing-snapshot",
    revision: input.revision,
    digest: input.digest,
    snapshotFileName: input.snapshotFileName,
    ...(input.contentBounds ? { contentBounds: input.contentBounds } : {}),
    createdAt: input.now,
  };
  const allOperations = [...document.operations, operation];
  const pruned = allOperations.slice(
    0,
    Math.max(0, allOperations.length - STUDY_CANVAS_MAX_SNAPSHOT_OPERATIONS),
  );
  const operations = allOperations.slice(-STUDY_CANVAS_MAX_SNAPSHOT_OPERATIONS);

  return {
    document: decodeStudyCanvasDocument({
      ...document,
      canvas: {
        ...document.canvas,
        updatedAt: input.now,
      },
      operations,
    }),
    prunedSnapshotFileNames: pruned.map((entry) => entry.snapshotFileName),
  };
}

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function studyCanvasIdForThread(environmentId: string, threadId: string): string {
  const source = `${environmentId}\u0000${threadId}`;
  const first = fnv1a32(source, 0x811c9dc5).toString(16).padStart(8, "0");
  const second = fnv1a32(source, 0x9e3779b9).toString(16).padStart(8, "0");
  return `thread-${first}${second}`;
}
