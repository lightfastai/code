import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { STUDY_EXTRACTED_MAX_UTF8_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import JSZip from "jszip";
import { vi } from "vite-plus/test";

import { importStudyDocument, resolveStudyLibraryPaths } from "./StudyLibrary.ts";
import {
  STUDY_EPUB_MAX_ENTRIES,
  STUDY_EPUB_MAX_ENTRY_EXPANDED_BYTES,
  STUDY_EPUB_MAX_PARSED_TEXT_CHARACTERS,
  STUDY_EPUB_MAX_TOTAL_EXPANDED_BYTES,
  STUDY_PDF_MAX_PAGES,
  STUDY_PDF_MAX_PAGE_TEXT_CHARACTERS,
  extractStudyDocumentText,
  readExtractedStudyDocument,
  validateStudyEpubArchiveMetadata,
  validateStudyExtractedSegments,
} from "./StudyTextExtractor.ts";

const unpdfMocks = vi.hoisted(() => ({
  extractText: vi.fn(),
  getDocumentProxy: vi.fn(),
}));

vi.mock("unpdf", () => unpdfMocks);

it.layer(NodeServices.layer)("StudyTextExtractor", (it) => {
  it("rejects invalid, per-entry, and total EPUB metadata without expanding fixtures", () => {
    assert.throws(
      () =>
        validateStudyEpubArchiveMetadata([
          { name: "missing.bin", compressedSize: undefined, uncompressedSize: undefined },
        ]),
      /metadata/i,
    );
    assert.throws(
      () =>
        validateStudyEpubArchiveMetadata([
          {
            name: "large.bin",
            compressedSize: STUDY_EPUB_MAX_ENTRY_EXPANDED_BYTES + 1,
            uncompressedSize: STUDY_EPUB_MAX_ENTRY_EXPANDED_BYTES + 1,
          },
        ]),
      /expanded byte limit/i,
    );
    assert.throws(
      () =>
        validateStudyEpubArchiveMetadata(
          Array.from(
            {
              length:
                Math.floor(
                  STUDY_EPUB_MAX_TOTAL_EXPANDED_BYTES / STUDY_EPUB_MAX_ENTRY_EXPANDED_BYTES,
                ) + 1,
            },
            (_, index) => ({
              name: `part-${index}.bin`,
              compressedSize: STUDY_EPUB_MAX_ENTRY_EXPANDED_BYTES,
              uncompressedSize: STUDY_EPUB_MAX_ENTRY_EXPANDED_BYTES,
            }),
          ),
        ),
      /total expanded byte limit/i,
    );
  });

  it("rejects final extracted UTF-8 text beyond the aggregate limit", () => {
    const sharedText = "😀".repeat(500_000);
    const segmentCount =
      Math.floor(STUDY_EXTRACTED_MAX_UTF8_BYTES / Buffer.byteLength(sharedText, "utf8")) + 1;
    assert.throws(
      () =>
        validateStudyExtractedSegments(
          Array.from({ length: segmentCount }, (_, order) => ({
            id: `segment-${order}`,
            order,
            anchor: { type: "pdf-page" as const, page: order + 1 },
            text: sharedText,
          })),
        ),
      /UTF-8 text limit/i,
    );
  });

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

  it.effect("rejects extraction when immutable object bytes disagree with the index identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-text-corrupt-object-",
        });
        const source = path.join(temp, "integrity.md");
        yield* fileSystem.writeFileString(source, "# Valid source\n");
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const document = yield* importStudyDocument({ paths, sourcePath: source });
        const objectPath = path.join(paths.root, ...document.objectKey.split("/"));
        yield* fileSystem.chmod(objectPath, 0o644);
        yield* fileSystem.writeFileString(objectPath, "# Corrupt replacement\n");

        const error = yield* extractStudyDocumentText({ paths, document }).pipe(Effect.flip);

        assert.strictEqual(error.operation, "read");
        assert.match(error.message, /immutable|identity|integrity/i);
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

  it.effect("rejects EPUBs whose archive entry count exceeds the extraction limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-text-epub-entries-",
        });
        const source = path.join(temp, "entries.epub");
        const archive = new JSZip();
        archive.file(
          "META-INF/container.xml",
          '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/package.opf" /></rootfiles></container>',
          { createFolders: false },
        );
        archive.file(
          "OPS/package.opf",
          '<?xml version="1.0"?><package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" /></manifest><spine><itemref idref="chapter" /></spine></package>',
          { createFolders: false },
        );
        archive.file("OPS/chapter.xhtml", "<html><body><p>Bounded.</p></body></html>", {
          createFolders: false,
        });
        for (let index = 0; index < STUDY_EPUB_MAX_ENTRIES - 2; index += 1) {
          archive.file(`unused-${index}.txt`, "");
        }
        yield* fileSystem.writeFile(
          source,
          yield* Effect.promise(() => archive.generateAsync({ type: "uint8array" })),
        );
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const document = yield* importStudyDocument({ paths, sourcePath: source });

        const error = yield* extractStudyDocumentText({ paths, document }).pipe(Effect.flip);
        assert.strictEqual(error.operation, "extract");
        assert.match(String(error.cause), /entry count/i);
      }),
    ),
  );

  it.effect("rejects suspicious EPUB compression expansion before parsing chapter HTML", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-text-epub-compression-",
        });
        const source = path.join(temp, "compressed.epub");
        const archive = new JSZip();
        archive.file(
          "META-INF/container.xml",
          '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/package.opf" /></rootfiles></container>',
        );
        archive.file(
          "OPS/package.opf",
          '<?xml version="1.0"?><package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" /></manifest><spine><itemref idref="chapter" /></spine></package>',
        );
        archive.file(
          "OPS/chapter.xhtml",
          `<html><body><p>${"A".repeat(128 * 1_024)}</p></body></html>`,
        );
        yield* fileSystem.writeFile(
          source,
          yield* Effect.promise(() =>
            archive.generateAsync({
              type: "uint8array",
              compression: "DEFLATE",
              compressionOptions: { level: 9 },
            }),
          ),
        );
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const document = yield* importStudyDocument({ paths, sourcePath: source });

        const error = yield* extractStudyDocumentText({ paths, document }).pipe(Effect.flip);
        assert.strictEqual(error.operation, "extract");
        assert.match(String(error.cause), /compression ratio/i);
      }),
    ),
  );

  it.effect("rejects EPUB chapter text beyond the parsed-text limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "study-text-epub-parsed-",
        });
        const source = path.join(temp, "parsed.epub");
        const archive = new JSZip();
        archive.file(
          "META-INF/container.xml",
          '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/package.opf" /></rootfiles></container>',
        );
        archive.file(
          "OPS/package.opf",
          '<?xml version="1.0"?><package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" /></manifest><spine><itemref idref="chapter" /></spine></package>',
        );
        archive.file(
          "OPS/chapter.xhtml",
          `<html><body><p>${"B".repeat(STUDY_EPUB_MAX_PARSED_TEXT_CHARACTERS + 1)}</p></body></html>`,
        );
        yield* fileSystem.writeFile(
          source,
          yield* Effect.promise(() =>
            archive.generateAsync({ type: "uint8array", compression: "STORE" }),
          ),
        );
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const document = yield* importStudyDocument({ paths, sourcePath: source });

        const error = yield* extractStudyDocumentText({ paths, document }).pipe(Effect.flip);
        assert.strictEqual(error.operation, "extract");
        assert.match(String(error.cause), /parsed text character limit/i);
      }),
    ),
  );

  it.effect("rejects excessive PDF page counts before requesting a page", () =>
    Effect.scoped(
      Effect.gen(function* () {
        unpdfMocks.extractText.mockReset();
        unpdfMocks.getDocumentProxy.mockReset();
        const getPage = vi.fn();
        const destroy = vi.fn(async () => undefined);
        unpdfMocks.getDocumentProxy.mockResolvedValue({
          numPages: STUDY_PDF_MAX_PAGES + 1,
          getPage,
          destroy,
        });
        unpdfMocks.extractText.mockRejectedValue(new Error("legacy full-document extraction"));
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "study-text-pdf-pages-" });
        const source = path.join(temp, "pages.pdf");
        yield* fileSystem.writeFileString(source, "%PDF-1.7\nfixture");
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const document = yield* importStudyDocument({ paths, sourcePath: source });

        const error = yield* extractStudyDocumentText({ paths, document }).pipe(Effect.flip);
        assert.strictEqual(error.operation, "extract");
        assert.match(String(error.cause), /page count/i);
        assert.strictEqual(unpdfMocks.getDocumentProxy.mock.calls.length, 1);
        assert.strictEqual(unpdfMocks.extractText.mock.calls.length, 0);
        assert.strictEqual(getPage.mock.calls.length, 0);
        assert.strictEqual(destroy.mock.calls.length, 1);
      }),
    ),
  );

  it.effect("rejects oversized PDF page text during sequential extraction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        unpdfMocks.extractText.mockReset();
        unpdfMocks.getDocumentProxy.mockReset();
        const getTextContent = vi.fn(async () => ({
          items: [{ str: "P".repeat(STUDY_PDF_MAX_PAGE_TEXT_CHARACTERS + 1), hasEOL: false }],
          styles: {},
          lang: null,
        }));
        const getPage = vi.fn(async () => ({ getTextContent }));
        const destroy = vi.fn(async () => undefined);
        unpdfMocks.getDocumentProxy.mockResolvedValue({ numPages: 1, getPage, destroy });
        unpdfMocks.extractText.mockResolvedValue({ totalPages: 1, text: ["legacy"] });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "study-text-pdf-size-" });
        const source = path.join(temp, "large.pdf");
        yield* fileSystem.writeFileString(source, "%PDF-1.7\nfixture");
        const paths = yield* resolveStudyLibraryPaths(path.join(temp, "library"));
        const document = yield* importStudyDocument({ paths, sourcePath: source });

        const error = yield* extractStudyDocumentText({ paths, document }).pipe(Effect.flip);
        assert.strictEqual(error.operation, "extract");
        assert.match(String(error.cause), /page text/i);
        assert.strictEqual(unpdfMocks.getDocumentProxy.mock.calls.length, 1);
        assert.strictEqual(unpdfMocks.extractText.mock.calls.length, 0);
        assert.strictEqual(getPage.mock.calls.length, 1);
        assert.strictEqual(destroy.mock.calls.length, 1);
      }),
    ),
  );
});
