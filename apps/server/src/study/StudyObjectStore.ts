import * as NodeCrypto from "node:crypto";

import type { StudyDocument, StudyDocumentFormat, StudyDocumentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { StudyLibraryPaths } from "./StudyLibrary.ts";

export const STUDY_OBJECT_MAX_BYTES = 512 * 1024 * 1024;

export type StudyObjectIdentity = Pick<
  StudyDocument,
  "id" | "sha256" | "format" | "objectKey" | "sizeBytes"
>;

export class StudyObjectIntegrityError extends Schema.TaggedErrorClass<StudyObjectIntegrityError>()(
  "StudyObjectIntegrityError",
  {
    operation: Schema.Literals(["read", "publish"]),
    path: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.detail} (${this.path})`;
  }
}

function extensionForFormat(format: StudyDocumentFormat): string {
  return format === "markdown" ? "md" : format;
}

export function expectedStudyObjectKey(id: StudyDocumentId, format: StudyDocumentFormat): string {
  return `objects/${id.slice(0, 2)}/${id}.${extensionForFormat(format)}`;
}

export function hashStudyObjectBytes(bytes: Uint8Array): StudyDocumentId {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex") as StudyDocumentId;
}

export function hasExpectedStudyObjectMagic(
  format: StudyDocumentFormat,
  bytes: Uint8Array,
): boolean {
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

function integrityError(input: {
  readonly operation: "read" | "publish";
  readonly path: string;
  readonly detail: string;
  readonly cause?: unknown;
}): StudyObjectIntegrityError {
  return new StudyObjectIntegrityError({
    operation: input.operation,
    path: input.path,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

const validateIdentity = Effect.fn("StudyObjectStore.validateIdentity")(function* (
  paths: StudyLibraryPaths,
  identity: StudyObjectIdentity,
  operation: "read" | "publish",
) {
  const path = yield* Path.Path;
  const expectedKey = expectedStudyObjectKey(identity.id, identity.format);
  const candidate = path.resolve(paths.root, ...expectedKey.split("/"));
  if (
    identity.id !== identity.sha256 ||
    !/^[0-9a-f]{64}$/.test(identity.id) ||
    identity.objectKey !== expectedKey ||
    !Number.isSafeInteger(identity.sizeBytes) ||
    identity.sizeBytes < 0 ||
    identity.sizeBytes > STUDY_OBJECT_MAX_BYTES
  ) {
    return yield* integrityError({
      operation,
      path: candidate,
      detail: "The immutable study object identity is invalid.",
    });
  }

  const expectedRelative = path.join(
    identity.id.slice(0, 2),
    `${identity.id}.${extensionForFormat(identity.format)}`,
  );
  const lexicalRelative = path.relative(paths.objects, candidate);
  if (lexicalRelative !== expectedRelative || path.isAbsolute(lexicalRelative)) {
    return yield* integrityError({
      operation,
      path: candidate,
      detail: "The immutable study object path does not match its identity.",
    });
  }
  return { candidate, expectedRelative };
});

const validateBytes = Effect.fn("StudyObjectStore.validateBytes")(function* (
  identity: StudyObjectIdentity,
  bytes: Uint8Array,
  objectPath: string,
  operation: "read" | "publish",
) {
  if (
    bytes.byteLength !== identity.sizeBytes ||
    hashStudyObjectBytes(bytes) !== identity.id ||
    !hasExpectedStudyObjectMagic(identity.format, bytes)
  ) {
    return yield* integrityError({
      operation,
      path: objectPath,
      detail: "The immutable study object bytes do not match their content identity.",
    });
  }
});

export const readValidatedStudyObject = Effect.fn("StudyObjectStore.readValidated")(function* (
  paths: StudyLibraryPaths,
  identity: StudyObjectIdentity,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { candidate, expectedRelative } = yield* validateIdentity(paths, identity, "read");
  const canonicalObjectsRoot = yield* fileSystem.realPath(paths.objects).pipe(
    Effect.mapError((cause) =>
      integrityError({
        operation: "read",
        path: paths.objects,
        detail: "Could not resolve the immutable study object store.",
        cause,
      }),
    ),
  );
  const canonicalPath = yield* fileSystem.realPath(candidate).pipe(
    Effect.mapError((cause) =>
      integrityError({
        operation: "read",
        path: candidate,
        detail: "Could not resolve the immutable study object.",
        cause,
      }),
    ),
  );
  const canonicalRelative = path.relative(canonicalObjectsRoot, canonicalPath);
  if (canonicalRelative !== expectedRelative || path.isAbsolute(canonicalRelative)) {
    return yield* integrityError({
      operation: "read",
      path: canonicalPath,
      detail: "The immutable study object resolves outside its content identity.",
    });
  }

  const info = yield* fileSystem.stat(canonicalPath).pipe(
    Effect.mapError((cause) =>
      integrityError({
        operation: "read",
        path: canonicalPath,
        detail: "Could not inspect the immutable study object.",
        cause,
      }),
    ),
  );
  if (info.type !== "File") {
    return yield* integrityError({
      operation: "read",
      path: canonicalPath,
      detail: "The immutable study object is not a regular file.",
    });
  }
  const inspectedSizeBytes = Number(info.size);
  if (!Number.isSafeInteger(inspectedSizeBytes) || inspectedSizeBytes !== identity.sizeBytes) {
    return yield* integrityError({
      operation: "read",
      path: canonicalPath,
      detail: "The immutable study object size does not match its content identity.",
    });
  }

  const bytes = yield* fileSystem.readFile(canonicalPath).pipe(
    Effect.mapError((cause) =>
      integrityError({
        operation: "read",
        path: canonicalPath,
        detail: "Could not read the immutable study object.",
        cause,
      }),
    ),
  );
  yield* validateBytes(identity, bytes, canonicalPath, "read");
  return { bytes, canonicalPath };
});

export const publishStudyObject = Effect.fn("StudyObjectStore.publish")(function* (
  paths: StudyLibraryPaths,
  identity: StudyObjectIdentity,
  validatedBytes: Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { candidate } = yield* validateIdentity(paths, identity, "publish");
  yield* validateBytes(identity, validatedBytes, candidate, "publish");
  const directory = path.dirname(candidate);
  yield* fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError((cause) =>
      integrityError({
        operation: "publish",
        path: directory,
        detail: "Could not create the immutable study object directory.",
        cause,
      }),
    ),
  );
  const canonicalObjectsRoot = yield* fileSystem.realPath(paths.objects).pipe(
    Effect.mapError((cause) =>
      integrityError({
        operation: "publish",
        path: paths.objects,
        detail: "Could not resolve the immutable study object store.",
        cause,
      }),
    ),
  );
  const canonicalDirectory = yield* fileSystem.realPath(directory).pipe(
    Effect.mapError((cause) =>
      integrityError({
        operation: "publish",
        path: directory,
        detail: "Could not resolve the immutable study object directory.",
        cause,
      }),
    ),
  );
  const canonicalDirectoryRelative = path.relative(canonicalObjectsRoot, canonicalDirectory);
  if (
    canonicalDirectoryRelative !== identity.id.slice(0, 2) ||
    path.isAbsolute(canonicalDirectoryRelative)
  ) {
    return yield* integrityError({
      operation: "publish",
      path: canonicalDirectory,
      detail: "The immutable study object directory resolves outside its content identity.",
    });
  }

  const publishResult = yield* Effect.result(
    Effect.scoped(
      Effect.gen(function* () {
        const tempPath = yield* fileSystem.makeTempFileScoped({
          directory,
          prefix: `.${path.basename(candidate)}.`,
          suffix: ".tmp",
        });
        yield* fileSystem.writeFile(tempPath, validatedBytes);
        const persistedBytes = yield* fileSystem.readFile(tempPath);
        yield* validateBytes(identity, persistedBytes, tempPath, "publish");
        yield* fileSystem.chmod(tempPath, 0o444);
        yield* fileSystem.link(tempPath, candidate);
      }),
    ),
  );
  if (publishResult._tag === "Success") return candidate;

  if (
    publishResult.failure._tag === "PlatformError" &&
    publishResult.failure.reason._tag === "AlreadyExists"
  ) {
    yield* readValidatedStudyObject(paths, identity).pipe(
      Effect.mapError((cause) =>
        integrityError({
          operation: "publish",
          path: candidate,
          detail: "The existing immutable study object is corrupt or has a different identity.",
          cause,
        }),
      ),
    );
    return candidate;
  }

  return yield* integrityError({
    operation: "publish",
    path: candidate,
    detail: "Could not publish the immutable study object.",
    cause: publishResult.failure,
  });
});
