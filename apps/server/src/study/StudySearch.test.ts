import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { importStudyDocument, resolveStudyLibraryPaths } from "./StudyLibrary.ts";
import { searchStudyLibrary } from "./StudySearch.ts";
import { extractStudyDocumentText } from "./StudyTextExtractor.ts";

it.layer(NodeServices.layer)("StudySearch", (it) => {
  it.effect("returns grounded excerpts and durable anchors scoped by tags", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "study-search-" });
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const source = path.join(temp, "calculus.md");
        yield* fileSystem.writeFileString(
          source,
          "# Derivatives\nA derivative is the instantaneous rate of change.\n\n## Tangents\nThe derivative gives the slope of the tangent line.\n",
        );
        const document = yield* importStudyDocument({
          paths,
          sourcePath: source,
          tags: ["math"],
        });
        yield* extractStudyDocumentText({ paths, document });

        const hits = yield* searchStudyLibrary(paths, {
          query: "derivative tangent slope",
          tags: ["math"],
          limit: 3,
        });

        assert.isAtLeast(hits.length, 1);
        assert.strictEqual(hits[0]?.documentId, document.id);
        assert.deepStrictEqual(hits[0]?.anchor, {
          type: "markdown-heading",
          headingPath: ["Derivatives", "Tangents"],
        });
        assert.include(hits[0]?.excerpt ?? "", "tangent line");

        const excluded = yield* searchStudyLibrary(paths, {
          query: "derivative",
          tags: ["physics"],
        });
        assert.deepStrictEqual(excluded, []);
      }),
    ),
  );
});
