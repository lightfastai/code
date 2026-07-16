import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  importStudyDocument,
  readStudyLibraryIndex,
  resolveStudyLibraryPaths,
  tagStudyDocument,
} from "./StudyLibrary.ts";

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
