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
});
