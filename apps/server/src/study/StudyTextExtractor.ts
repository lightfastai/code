import {
  StudyExtractedDocument,
  type StudyDocument,
  type StudyTextSegment,
} from "@t3tools/contracts";
import { load as loadHtml } from "cheerio";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import JSZip from "jszip";
import { extractText as extractPdfText } from "unpdf";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import type { StudyLibraryPaths } from "./StudyLibrary.ts";

const decodeExtractedDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StudyExtractedDocument),
);
const encodeExtractedDocument = Schema.encodeEffect(Schema.fromJsonString(StudyExtractedDocument));

export class StudyTextExtractionError extends Schema.TaggedErrorClass<StudyTextExtractionError>()(
  "StudyTextExtractionError",
  {
    operation: Schema.Literals(["extract", "read", "write"]),
    documentId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.detail} [${this.documentId.slice(0, 12)}]`;
  }
}

export const extractedDocumentPath = Effect.fn("StudyTextExtractor.derivedPath")(function* (
  paths: StudyLibraryPaths,
  document: Pick<StudyDocument, "id">,
) {
  const path = yield* Path.Path;
  return path.join(paths.root, "derived", document.id.slice(0, 2), `${document.id}.text.json`);
});

const contentObjectPath = Effect.fn("StudyTextExtractor.objectPath")(function* (
  paths: StudyLibraryPaths,
  document: Pick<StudyDocument, "objectKey">,
) {
  const path = yield* Path.Path;
  return path.join(paths.root, ...document.objectKey.split("/"));
});

function normalizeText(raw: string): string {
  return raw
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.replaceAll(/\s+/g, " ").trim())
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveArchivePath(packagePath: string, href: string): string {
  const parts = packagePath.split("/").slice(0, -1);
  for (const part of href.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function segmentId(document: StudyDocument, order: number): string {
  return `${document.id.slice(0, 24)}-segment-${order}`;
}

function extractMarkdownSegments(document: StudyDocument, raw: string): StudyTextSegment[] {
  const segments: StudyTextSegment[] = [];
  const headingPath: string[] = [document.title];
  let currentHeading = document.title;
  let lines: string[] = [];

  const flush = () => {
    const text = normalizeText(lines.join("\n"));
    if (text.length > 0) {
      const order = segments.length;
      segments.push({
        id: segmentId(document, order),
        order,
        heading: currentHeading,
        anchor: { type: "markdown-heading", headingPath: [...headingPath] },
        text,
      });
    }
    lines = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    flush();
    const level = match[1]?.length ?? 1;
    const heading = normalizeText(match[2] ?? "Section");
    headingPath.splice(Math.max(0, level - 1));
    while (headingPath.length < level - 1) headingPath.push("Untitled section");
    headingPath.push(heading);
    currentHeading = heading;
  }
  flush();
  return segments;
}

const extractPdfSegments = Effect.fn("StudyTextExtractor.extractPdf")(function* (
  document: StudyDocument,
  bytes: Uint8Array,
) {
  const pages = yield* Effect.tryPromise({
    try: async () => {
      const result = await extractPdfText(bytes, { mergePages: false });
      return result.text;
    },
    catch: (cause) =>
      new StudyTextExtractionError({
        operation: "extract",
        documentId: document.id,
        detail: "Could not extract text from the PDF.",
        cause,
      }),
  });
  return pages.flatMap((pageText, index) => {
    const text = normalizeText(pageText);
    if (text.length === 0) return [];
    const order = index;
    return [
      {
        id: segmentId(document, order),
        order,
        heading: `Page ${index + 1}`,
        anchor: { type: "pdf-page" as const, page: index + 1 },
        text,
      },
    ];
  });
});

function textFromChapterHtml(raw: string): {
  readonly title: string | undefined;
  readonly text: string;
} {
  const html = loadHtml(raw);
  html("script, style, nav, svg").remove();
  const title = normalizeText(html("h1, h2, h3, title").first().text());
  const blocks = html("h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption")
    .toArray()
    .map((element) => normalizeText(html(element).text()))
    .filter((text) => text.length > 0);
  const text = normalizeText(blocks.length > 0 ? blocks.join("\n\n") : html("body").text());
  return { title: title.length > 0 ? title : undefined, text };
}

const extractEpubSegments = Effect.fn("StudyTextExtractor.extractEpub")(function* (
  document: StudyDocument,
  bytes: Uint8Array,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const archive = await JSZip.loadAsync(bytes);
      const containerFile = archive.file("META-INF/container.xml");
      if (!containerFile) throw new Error("EPUB container.xml is missing.");
      const container = loadHtml(await containerFile.async("string"), { xmlMode: true });
      const packagePath = container("rootfile").attr("full-path");
      if (!packagePath) throw new Error("EPUB package path is missing.");
      const packageFile = archive.file(packagePath);
      if (!packageFile) throw new Error("EPUB package file is missing.");
      const packageXml = loadHtml(await packageFile.async("string"), { xmlMode: true });
      const manifest = new Map<string, string>();
      packageXml("manifest item").each((_index, element) => {
        const id = packageXml(element).attr("id");
        const href = packageXml(element).attr("href");
        if (id && href) manifest.set(id, href);
      });
      const spineIds = packageXml("spine itemref")
        .toArray()
        .flatMap((element) => {
          const id = packageXml(element).attr("idref");
          return id ? [id] : [];
        });
      const segments: StudyTextSegment[] = [];
      for (const [spineIndex, id] of spineIds.entries()) {
        const href = manifest.get(id);
        if (!href) continue;
        const decodedHref = decodeURIComponent(href.split("#")[0] ?? href);
        const archivePath = resolveArchivePath(packagePath, decodedHref);
        const chapterFile = archive.file(archivePath);
        if (!chapterFile) continue;
        const chapter = textFromChapterHtml(await chapterFile.async("string"));
        if (chapter.text.length === 0) continue;
        const order = segments.length;
        segments.push({
          id: segmentId(document, order),
          order,
          ...(chapter.title ? { heading: chapter.title } : {}),
          anchor: { type: "epub-spine", href, spineIndex },
          text: chapter.text,
        });
      }
      return segments;
    },
    catch: (cause) =>
      new StudyTextExtractionError({
        operation: "extract",
        documentId: document.id,
        detail: "Could not extract text from the EPUB.",
        cause,
      }),
  });
});

export const extractStudyDocumentText = Effect.fn("StudyTextExtractor.extract")(function* (input: {
  readonly paths: StudyLibraryPaths;
  readonly document: StudyDocument;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const objectPath = yield* contentObjectPath(input.paths, input.document);
  const bytes = yield* fileSystem.readFile(objectPath).pipe(
    Effect.mapError(
      (cause) =>
        new StudyTextExtractionError({
          operation: "read",
          documentId: input.document.id,
          detail: "Could not read the immutable study object.",
          cause,
        }),
    ),
  );
  const segments =
    input.document.format === "markdown"
      ? extractMarkdownSegments(input.document, new TextDecoder().decode(bytes))
      : input.document.format === "pdf"
        ? yield* extractPdfSegments(input.document, bytes)
        : yield* extractEpubSegments(input.document, bytes);
  const extractedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const extracted = {
    version: 1,
    documentId: input.document.id,
    segments,
    extractedAt,
  } satisfies StudyExtractedDocument;
  const destination = yield* extractedDocumentPath(input.paths, input.document);
  const encoded = yield* encodeExtractedDocument(extracted).pipe(
    Effect.mapError(
      (cause) =>
        new StudyTextExtractionError({
          operation: "write",
          documentId: input.document.id,
          detail: "Could not encode extracted study text.",
          cause,
        }),
    ),
  );
  yield* writeFileStringAtomically({ filePath: destination, contents: `${encoded}\n` }).pipe(
    Effect.mapError(
      (cause) =>
        new StudyTextExtractionError({
          operation: "write",
          documentId: input.document.id,
          detail: "Could not persist extracted study text.",
          cause,
        }),
    ),
  );
  return extracted;
});

export const readExtractedStudyDocument = Effect.fn("StudyTextExtractor.readExtracted")(function* (
  paths: StudyLibraryPaths,
  document: Pick<StudyDocument, "id">,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const source = yield* extractedDocumentPath(paths, document);
  const raw = yield* fileSystem.readFileString(source).pipe(
    Effect.mapError(
      (cause) =>
        new StudyTextExtractionError({
          operation: "read",
          documentId: document.id,
          detail: "Extracted study text is unavailable.",
          cause,
        }),
    ),
  );
  return yield* decodeExtractedDocument(raw).pipe(
    Effect.mapError(
      (cause) =>
        new StudyTextExtractionError({
          operation: "read",
          documentId: document.id,
          detail: "Extracted study text is invalid.",
          cause,
        }),
    ),
  );
});
