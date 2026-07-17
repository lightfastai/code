import * as NodeCrypto from "node:crypto";

import {
  StudyLibraryIndex,
  type StudyDocument,
  type StudyDocumentFormat,
  type StudyDocumentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { withStudyLibraryMutationLock } from "./StudyLibraryMutationLock.ts";

const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const decodeIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(StudyLibraryIndex));
const encodeIndex = Schema.encodeEffect(Schema.fromJsonString(StudyLibraryIndex));

export class StudyLibraryError extends Schema.TaggedErrorClass<StudyLibraryError>()(
  "StudyLibraryError",
  {
    operation: Schema.Literals(["read-index", "write-index", "import", "tag"]),
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.detail} (${this.path})`;
  }
}

const isStudyLibraryError = Schema.is(StudyLibraryError);

export interface StudyLibraryPaths {
  readonly root: string;
  readonly objects: string;
  readonly index: string;
}

export const resolveStudyLibraryPaths = Effect.fn("StudyLibrary.resolvePaths")(function* (
  root: string,
) {
  const path = yield* Path.Path;
  const normalizedRoot = path.resolve(root);
  return {
    root: normalizedRoot,
    objects: path.join(normalizedRoot, "objects"),
    index: path.join(normalizedRoot, "index.json"),
  } satisfies StudyLibraryPaths;
});

const emptyIndex = (): StudyLibraryIndex => ({ version: 1, documents: [] });

export const readStudyLibraryIndex = Effect.fn("StudyLibrary.readIndex")(function* (
  paths: StudyLibraryPaths,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem.exists(paths.index).pipe(
    Effect.mapError(
      (cause) =>
        new StudyLibraryError({
          operation: "read-index",
          path: paths.index,
          detail: "Could not inspect the study library index.",
          cause,
        }),
    ),
  );
  if (!exists) return emptyIndex();

  const raw = yield* fileSystem.readFileString(paths.index).pipe(
    Effect.mapError(
      (cause) =>
        new StudyLibraryError({
          operation: "read-index",
          path: paths.index,
          detail: "Could not read the study library index.",
          cause,
        }),
    ),
  );
  return yield* decodeIndex(raw).pipe(
    Effect.mapError(
      (cause) =>
        new StudyLibraryError({
          operation: "read-index",
          path: paths.index,
          detail: "The study library index is invalid.",
          cause,
        }),
    ),
  );
});

export const resolveStudyDocumentMountPaths = Effect.fn("StudyLibrary.resolveMountPaths")(
  function* (paths: StudyLibraryPaths, documentIds: ReadonlyArray<StudyDocumentId>) {
    const selectedIds = Array.from(new Set(documentIds));
    if (
      selectedIds.length === 0 ||
      selectedIds.length > 32 ||
      selectedIds.some((documentId) => !/^[0-9a-f]{64}$/.test(documentId))
    ) {
      return [] as ReadonlyArray<string>;
    }

    return yield* Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const index = yield* readStudyLibraryIndex(paths);
      const documents = selectedIds.map((documentId) =>
        index.documents.find((document) => document.id === documentId),
      );
      if (documents.some((document) => document === undefined)) {
        return [] as ReadonlyArray<string>;
      }

      const canonicalObjectsRoot = yield* fileSystem.realPath(paths.objects);
      const resolved: string[] = [];
      for (const document of documents) {
        if (document === undefined || document.sha256 !== document.id) {
          return [] as ReadonlyArray<string>;
        }
        const expectedObjectKey = `objects/${document.id.slice(0, 2)}/${document.id}.${extensionForFormat(document.format)}`;
        if (document.objectKey !== expectedObjectKey) return [] as ReadonlyArray<string>;

        const candidate = path.resolve(paths.root, ...document.objectKey.split("/"));
        const lexicalRelative = path.relative(paths.objects, candidate);
        if (
          lexicalRelative === "" ||
          lexicalRelative === ".." ||
          lexicalRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(lexicalRelative)
        ) {
          return [] as ReadonlyArray<string>;
        }

        const canonicalCandidate = yield* fileSystem.realPath(candidate);
        const canonicalRelative = path.relative(canonicalObjectsRoot, canonicalCandidate);
        if (
          canonicalRelative === "" ||
          canonicalRelative === ".." ||
          canonicalRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(canonicalRelative)
        ) {
          return [] as ReadonlyArray<string>;
        }
        const info = yield* fileSystem.stat(canonicalCandidate);
        if (info.type !== "File") return [] as ReadonlyArray<string>;
        resolved.push(canonicalCandidate);
      }
      return resolved;
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  },
);

const writeStudyLibraryIndex = Effect.fn("StudyLibrary.writeIndex")(function* (
  paths: StudyLibraryPaths,
  index: StudyLibraryIndex,
) {
  const encoded = yield* encodeIndex(index).pipe(
    Effect.mapError(
      (cause) =>
        new StudyLibraryError({
          operation: "write-index",
          path: paths.index,
          detail: "Could not encode the study library index.",
          cause,
        }),
    ),
  );
  yield* writeFileStringAtomically({
    filePath: paths.index,
    contents: `${encoded}\n`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new StudyLibraryError({
          operation: "write-index",
          path: paths.index,
          detail: "Could not write the study library index.",
          cause,
        }),
    ),
  );
});

function formatFromFileName(fileName: string): StudyDocumentFormat | null {
  const extension = fileName.toLowerCase().split(".").at(-1);
  switch (extension) {
    case "pdf":
      return "pdf";
    case "epub":
      return "epub";
    case "md":
    case "markdown":
      return "markdown";
    default:
      return null;
  }
}

function extensionForFormat(format: StudyDocumentFormat): string {
  return format === "markdown" ? "md" : format;
}

function hasExpectedMagic(format: StudyDocumentFormat, bytes: Uint8Array): boolean {
  if (format === "markdown") return true;
  if (format === "pdf") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46
    );
  }
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function titleFromFileName(fileName: string): string {
  const extensionIndex = fileName.lastIndexOf(".");
  const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
  const title = stem.replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ").trim();
  return title.length > 0 ? title : fileName;
}

const normalizeTags = Effect.fn("StudyLibrary.normalizeTags")(function* (
  tags: ReadonlyArray<string>,
  sourcePath: string,
) {
  const normalized = Array.from(
    new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0)),
  ).sort();
  const invalid = normalized.find((tag) => tag.length > 64);
  if (invalid) {
    return yield* new StudyLibraryError({
      operation: "tag",
      path: sourcePath,
      detail: `Study tag '${invalid}' exceeds 64 characters.`,
    });
  }
  return normalized;
});

const persistObject = Effect.fn("StudyLibrary.persistObject")(function* (
  paths: StudyLibraryPaths,
  sourcePath: string,
  objectKey: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const objectPath = path.join(paths.root, ...objectKey.split("/"));
  const exists = yield* fileSystem.exists(objectPath);
  if (exists) return objectPath;

  yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = path.dirname(objectPath);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
        directory,
        prefix: ".import-",
      });
      const tempPath = path.join(tempDirectory, "content.tmp");
      yield* fileSystem.copyFile(sourcePath, tempPath);
      yield* fileSystem.rename(tempPath, objectPath);
    }),
  );
  return objectPath;
});

export const importStudyDocument = Effect.fn("StudyLibrary.importDocument")(function* (input: {
  readonly paths: StudyLibraryPaths;
  readonly sourcePath: string;
  readonly tags?: ReadonlyArray<string>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.resolve(input.sourcePath);
  const fileName = path.basename(sourcePath);
  const format = formatFromFileName(fileName);
  if (!format) {
    return yield* new StudyLibraryError({
      operation: "import",
      path: sourcePath,
      detail: "Only PDF, EPUB, and Markdown documents can be imported.",
    });
  }

  const info = yield* fileSystem.stat(sourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new StudyLibraryError({
          operation: "import",
          path: sourcePath,
          detail: "Could not inspect the document.",
          cause,
        }),
    ),
  );
  if (info.type !== "File") {
    return yield* new StudyLibraryError({
      operation: "import",
      path: sourcePath,
      detail: "The import source must be a file.",
    });
  }
  const sizeBytes = Number(info.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes > MAX_IMPORT_BYTES) {
    return yield* new StudyLibraryError({
      operation: "import",
      path: sourcePath,
      detail: "The document is larger than the 512 MB local import limit.",
    });
  }

  const bytes = yield* fileSystem.readFile(sourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new StudyLibraryError({
          operation: "import",
          path: sourcePath,
          detail: "Could not read the document.",
          cause,
        }),
    ),
  );
  if (!hasExpectedMagic(format, bytes)) {
    return yield* new StudyLibraryError({
      operation: "import",
      path: sourcePath,
      detail: `The file contents do not match the .${extensionForFormat(format)} format.`,
    });
  }

  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex") as StudyDocumentId;
  const objectKey = `objects/${sha256.slice(0, 2)}/${sha256}.${extensionForFormat(format)}`;
  const tags = yield* normalizeTags(input.tags ?? [], sourcePath);
  yield* persistObject(input.paths, sourcePath, objectKey).pipe(
    Effect.mapError((cause) =>
      isStudyLibraryError(cause)
        ? cause
        : new StudyLibraryError({
            operation: "import",
            path: sourcePath,
            detail: "Could not persist the immutable library object.",
            cause,
          }),
    ),
  );

  const importedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const document = {
    id: sha256,
    sha256,
    format,
    title: titleFromFileName(fileName),
    fileName,
    objectKey,
    sizeBytes,
    tags,
    importedAt,
  } satisfies StudyDocument;
  return yield* withStudyLibraryMutationLock(
    input.paths.index,
    Effect.gen(function* () {
      const index = yield* readStudyLibraryIndex(input.paths);
      const existing = index.documents.find((candidate) => candidate.id === sha256);
      if (existing) {
        const mergedTags = Array.from(new Set([...existing.tags, ...tags])).sort();
        if (mergedTags.length === existing.tags.length) return existing;
        const updated = { ...existing, tags: mergedTags } satisfies StudyDocument;
        yield* writeStudyLibraryIndex(input.paths, {
          version: 1,
          documents: index.documents.map((candidate) =>
            candidate.id === updated.id ? updated : candidate,
          ),
        });
        return updated;
      }

      yield* writeStudyLibraryIndex(input.paths, {
        version: 1,
        documents: [...index.documents, document].sort((left, right) =>
          left.title.localeCompare(right.title),
        ),
      });
      return document;
    }),
  );
});

export const tagStudyDocument = Effect.fn("StudyLibrary.tagDocument")(function* (input: {
  readonly paths: StudyLibraryPaths;
  readonly documentId: StudyDocumentId;
  readonly tags: ReadonlyArray<string>;
}) {
  const tags = yield* normalizeTags(input.tags, input.paths.index);
  return yield* withStudyLibraryMutationLock(
    input.paths.index,
    Effect.gen(function* () {
      const index = yield* readStudyLibraryIndex(input.paths);
      const existing = index.documents.find((document) => document.id === input.documentId);
      if (!existing) {
        return yield* new StudyLibraryError({
          operation: "tag",
          path: input.paths.index,
          detail: `Study document '${input.documentId}' was not found.`,
        });
      }
      const updated = {
        ...existing,
        tags: Array.from(new Set([...existing.tags, ...tags])).sort(),
      } satisfies StudyDocument;
      yield* writeStudyLibraryIndex(input.paths, {
        version: 1,
        documents: index.documents.map((document) =>
          document.id === input.documentId ? updated : document,
        ),
      });
      return updated;
    }),
  );
});
