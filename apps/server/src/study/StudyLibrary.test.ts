import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { StudyLibraryIndex } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  importStudyDocument,
  readStudyLibraryIndex,
  resolveStudyDocumentMountPaths,
  resolveStudyLibraryPaths,
  tagStudyDocument,
} from "./StudyLibrary.ts";

const encodeIndex = Schema.encodeEffect(Schema.fromJsonString(StudyLibraryIndex));

it.layer(NodeServices.layer)("StudyLibrary", (it) => {
  it.effect("imports immutable documents and merges duplicate tags", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "study-library-test-" });
        const source = path.join(temp, "Linear_Algebra.pdf");
        yield* fileSystem.writeFileString(source, "%PDF-1.7\nfixture");
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));

        const first = yield* importStudyDocument({
          paths,
          sourcePath: source,
          tags: ["Math", "vectors"],
        });
        const duplicate = yield* importStudyDocument({
          paths,
          sourcePath: source,
          tags: ["geometry"],
        });

        assert.strictEqual(first.id, duplicate.id);
        assert.strictEqual(first.title, "Linear Algebra");
        assert.deepStrictEqual(duplicate.tags, ["geometry", "math", "vectors"]);
        assert.isTrue(
          yield* fileSystem.exists(path.join(paths.root, ...first.objectKey.split("/"))),
        );

        const index = yield* readStudyLibraryIndex(paths);
        assert.strictEqual(index.documents.length, 1);
        assert.strictEqual(index.documents[0]?.sha256, first.id);
      }),
    ),
  );

  it.effect("tags imported documents without changing their content identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "study-library-tag-" });
        const source = path.join(temp, "notes.md");
        yield* fileSystem.writeFileString(source, "# Eigenvectors\n");
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const imported = yield* importStudyDocument({ paths, sourcePath: source });

        const tagged = yield* tagStudyDocument({
          paths,
          documentId: imported.id,
          tags: ["Linear Algebra", "revision"],
        });

        assert.strictEqual(tagged.id, imported.id);
        assert.deepStrictEqual(tagged.tags, ["linear algebra", "revision"]);
      }),
    ),
  );

  it.effect("resolves selected IDs to canonical library objects and fails closed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-library-mounts-",
        });
        const source = path.join(temp, "selected.md");
        yield* fileSystem.writeFileString(source, "# Selected\n");
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const imported = yield* importStudyDocument({ paths, sourcePath: source });
        const objectPath = path.join(paths.root, ...imported.objectKey.split("/"));

        assert.deepStrictEqual(yield* resolveStudyDocumentMountPaths(paths, [imported.id]), [
          yield* fileSystem.realPath(objectPath),
        ]);
        assert.deepStrictEqual(yield* resolveStudyDocumentMountPaths(paths, []), []);
        assert.deepStrictEqual(
          yield* resolveStudyDocumentMountPaths(paths, ["f".repeat(64) as typeof imported.id]),
          [],
        );
        assert.deepStrictEqual(
          yield* resolveStudyDocumentMountPaths(paths, ["../../etc/passwd" as typeof imported.id]),
          [],
        );

        yield* fileSystem.chmod(objectPath, 0o644);
        yield* fileSystem.writeFileString(objectPath, "corrupt object bytes");
        assert.deepStrictEqual(yield* resolveStudyDocumentMountPaths(paths, [imported.id]), []);

        const outside = path.join(temp, "outside.md");
        yield* fileSystem.writeFileString(outside, "outside");
        const index = yield* readStudyLibraryIndex(paths);
        const corruptedIndex = yield* encodeIndex({
          ...index,
          documents: index.documents.map((document) => ({
            ...document,
            objectKey: "../outside.md",
          })),
        });
        yield* fileSystem.writeFileString(paths.index, `${corruptedIndex}\n`);

        assert.deepStrictEqual(yield* resolveStudyDocumentMountPaths(paths, [imported.id]), []);
      }),
    ),
  );

  it.effect("preserves concurrent imports released through one start barrier", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-library-concurrent-import-",
        });
        const firstSource = path.join(temp, "first.md");
        const secondSource = path.join(temp, "second.md");
        yield* fileSystem.writeFileString(firstSource, "# First\n\nAlpha");
        yield* fileSystem.writeFileString(secondSource, "# Second\n\nBeta");
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const start = yield* Deferred.make<void>();
        const first = yield* Deferred.await(start).pipe(
          Effect.andThen(importStudyDocument({ paths, sourcePath: firstSource })),
          Effect.forkChild,
        );
        const second = yield* Deferred.await(start).pipe(
          Effect.andThen(importStudyDocument({ paths, sourcePath: secondSource })),
          Effect.forkChild,
        );

        yield* Deferred.succeed(start, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);

        const index = yield* readStudyLibraryIndex(paths);
        assert.deepStrictEqual(index.documents.map((document) => document.title).sort(), [
          "first",
          "second",
        ]);
      }),
    ),
  );

  it.effect("merges concurrent tag mutations released through one start barrier", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-library-concurrent-tag-",
        });
        const source = path.join(temp, "shared.md");
        yield* fileSystem.writeFileString(source, "# Shared\n");
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const imported = yield* importStudyDocument({ paths, sourcePath: source });
        const start = yield* Deferred.make<void>();
        const first = yield* Deferred.await(start).pipe(
          Effect.andThen(tagStudyDocument({ paths, documentId: imported.id, tags: ["alpha"] })),
          Effect.forkChild,
        );
        const second = yield* Deferred.await(start).pipe(
          Effect.andThen(tagStudyDocument({ paths, documentId: imported.id, tags: ["beta"] })),
          Effect.forkChild,
        );

        yield* Deferred.succeed(start, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);

        const index = yield* readStudyLibraryIndex(paths);
        assert.deepStrictEqual(index.documents[0]?.tags, ["alpha", "beta"]);
      }),
    ),
  );

  it.effect("rejects files whose contents do not match their declared format", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "study-library-magic-" });
        const source = path.join(temp, "not-a-book.pdf");
        yield* fileSystem.writeFileString(source, "plain text");
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));

        const result = yield* Effect.result(importStudyDocument({ paths, sourcePath: source }));
        assert.strictEqual(result._tag, "Failure");
      }),
    ),
  );

  it.effect("rejects a corrupt existing object without replacing or indexing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-library-corrupt-object-",
        });
        const source = path.join(temp, "identity.md");
        const contents = "# Immutable identity\n";
        yield* fileSystem.writeFileString(source, contents);
        const sha256 = NodeCrypto.createHash("sha256").update(contents).digest("hex");
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const objectPath = path.join(paths.objects, sha256.slice(0, 2), `${sha256}.md`);
        yield* fileSystem.makeDirectory(path.dirname(objectPath), { recursive: true });
        yield* fileSystem.writeFileString(objectPath, "corrupt object bytes");

        const error = yield* importStudyDocument({ paths, sourcePath: source }).pipe(Effect.flip);

        assert.match(error.message, /immutable|identity|corrupt/i);
        assert.strictEqual(yield* fileSystem.readFileString(objectPath), "corrupt object bytes");
        assert.deepStrictEqual((yield* readStudyLibraryIndex(paths)).documents, []);
      }),
    ),
  );

  it.effect("publishes the validated bytes when the source changes after hashing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-library-source-race-",
        });
        const source = path.join(temp, "race.md");
        const original = "# Original validated bytes\n";
        const replacement = "# Mutated after validation\n";
        yield* fileSystem.writeFileString(source, original);
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        let sourceMutated = false;
        const racingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          makeDirectory: (directory, options) => {
            if (!sourceMutated && directory.startsWith(paths.objects)) {
              sourceMutated = true;
              return fileSystem
                .writeFileString(source, replacement)
                .pipe(Effect.andThen(fileSystem.makeDirectory(directory, options)));
            }
            return fileSystem.makeDirectory(directory, options);
          },
        });

        const imported = yield* importStudyDocument({ paths, sourcePath: source }).pipe(
          Effect.provideService(FileSystem.FileSystem, racingFileSystem),
        );
        const objectPath = path.join(paths.root, ...imported.objectKey.split("/"));

        assert.isTrue(sourceMutated);
        assert.strictEqual(yield* fileSystem.readFileString(source), replacement);
        assert.strictEqual(yield* fileSystem.readFileString(objectPath), original);
        assert.strictEqual(
          imported.sha256,
          NodeCrypto.createHash("sha256").update(original).digest("hex"),
        );
        assert.strictEqual(imported.sizeBytes, Buffer.byteLength(original));
      }),
    ),
  );

  it.effect("derives size metadata from the validated read instead of a stale stat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-library-stat-race-",
        });
        const source = path.join(temp, "growing.md");
        const initial = "# Small\n";
        const replacement = "# Larger validated document\n\nContent added after stat.\n";
        yield* fileSystem.writeFileString(source, initial);
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        let sourceMutated = false;
        const racingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          readFile: (filePath) => {
            if (!sourceMutated && filePath === source) {
              sourceMutated = true;
              return fileSystem
                .writeFileString(source, replacement)
                .pipe(Effect.andThen(fileSystem.readFile(filePath)));
            }
            return fileSystem.readFile(filePath);
          },
        });

        const imported = yield* importStudyDocument({ paths, sourcePath: source }).pipe(
          Effect.provideService(FileSystem.FileSystem, racingFileSystem),
        );

        assert.isTrue(sourceMutated);
        assert.strictEqual(imported.sizeBytes, Buffer.byteLength(replacement));
        assert.strictEqual(
          imported.sha256,
          NodeCrypto.createHash("sha256").update(replacement).digest("hex"),
        );
      }),
    ),
  );

  it.effect("publishes one winner without replacing it during concurrent creation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-library-object-create-race-",
        });
        const firstSource = path.join(temp, "first-copy.md");
        const secondSource = path.join(temp, "second-copy.md");
        const contents = "# Shared immutable bytes\n";
        yield* fileSystem.writeFileString(firstSource, contents);
        yield* fileSystem.writeFileString(secondSource, contents);
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const bothAtPublish = yield* Deferred.make<void>();
        let linkArrivals = 0;
        let linkSuccesses = 0;
        let linkCollisions = 0;
        const racingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          link: (fromPath, toPath) =>
            Effect.gen(function* () {
              linkArrivals += 1;
              if (linkArrivals === 2) {
                yield* Deferred.succeed(bothAtPublish, undefined);
              } else {
                yield* Deferred.await(bothAtPublish);
              }
              const result = yield* Effect.result(fileSystem.link(fromPath, toPath));
              if (result._tag === "Success") {
                linkSuccesses += 1;
                return;
              }
              if (result.failure.reason._tag === "AlreadyExists") linkCollisions += 1;
              return yield* result.failure;
            }),
        });
        const start = yield* Deferred.make<void>();
        const first = yield* Deferred.await(start).pipe(
          Effect.andThen(importStudyDocument({ paths, sourcePath: firstSource })),
          Effect.provideService(FileSystem.FileSystem, racingFileSystem),
          Effect.forkChild,
        );
        const second = yield* Deferred.await(start).pipe(
          Effect.andThen(importStudyDocument({ paths, sourcePath: secondSource })),
          Effect.provideService(FileSystem.FileSystem, racingFileSystem),
          Effect.forkChild,
        );

        yield* Deferred.succeed(start, undefined);
        const [firstImported, secondImported] = yield* Effect.all([
          Fiber.join(first),
          Fiber.join(second),
        ]);

        assert.strictEqual(firstImported.id, secondImported.id);
        assert.strictEqual(linkArrivals, 2);
        assert.strictEqual(linkSuccesses, 1);
        assert.strictEqual(linkCollisions, 1);
        assert.strictEqual(
          yield* fileSystem.readFileString(
            path.join(paths.root, ...firstImported.objectKey.split("/")),
          ),
          contents,
        );
      }),
    ),
  );
});
