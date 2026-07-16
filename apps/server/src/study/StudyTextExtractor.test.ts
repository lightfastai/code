import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import JSZip from "jszip";

import { importStudyDocument, resolveStudyLibraryPaths } from "./StudyLibrary.ts";
import { extractStudyDocumentText, readExtractedStudyDocument } from "./StudyTextExtractor.ts";

it.layer(NodeServices.layer)("StudyTextExtractor", (it) => {
  it.effect("extracts stable heading-anchored Markdown segments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "study-text-md-" });
        const source = path.join(temp, "vectors.md");
        yield* fileSystem.writeFileString(
          source,
          "# Vectors\nMagnitude and direction.\n\n## Addition\nUse the parallelogram rule.\n",
        );
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const document = yield* importStudyDocument({ paths, sourcePath: source });

        const extracted = yield* extractStudyDocumentText({ paths, document });
        assert.strictEqual(extracted.segments.length, 2);
        assert.deepStrictEqual(extracted.segments[1]?.anchor, {
          type: "markdown-heading",
          headingPath: ["Vectors", "Addition"],
        });
        assert.include(extracted.segments[1]?.text ?? "", "parallelogram");

        const persisted = yield* readExtractedStudyDocument(paths, document);
        assert.deepStrictEqual(persisted.segments, extracted.segments);
      }),
    ),
  );

  it.effect("extracts EPUB spine chapters with durable href anchors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "study-text-epub-" });
        const source = path.join(temp, "geometry.epub");
        const archive = new JSZip();
        archive.file(
          "META-INF/container.xml",
          '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/package.opf" /></rootfiles></container>',
        );
        archive.file(
          "OPS/package.opf",
          '<?xml version="1.0"?><package><manifest><item id="chapter-1" href="chapter-1.xhtml" media-type="application/xhtml+xml" /></manifest><spine><itemref idref="chapter-1" /></spine></package>',
        );
        archive.file(
          "OPS/chapter-1.xhtml",
          "<html><body><h1>Triangles</h1><p>The angles sum to 180 degrees.</p></body></html>",
        );
        yield* fileSystem.writeFile(
          source,
          yield* Effect.promise(() => archive.generateAsync({ type: "uint8array" })),
        );
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const document = yield* importStudyDocument({ paths, sourcePath: source });

        const extracted = yield* extractStudyDocumentText({ paths, document });
        assert.strictEqual(extracted.segments.length, 1);
        assert.deepStrictEqual(extracted.segments[0]?.anchor, {
          type: "epub-spine",
          href: "chapter-1.xhtml",
          spineIndex: 0,
        });
        assert.include(extracted.segments[0]?.text ?? "", "180 degrees");
      }),
    ),
  );
});
