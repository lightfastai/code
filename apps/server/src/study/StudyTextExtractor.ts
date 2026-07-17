import {
  STUDY_EXTRACTED_MAX_SEGMENT_CHARACTERS,
  STUDY_EXTRACTED_MAX_SEGMENTS,
  STUDY_EXTRACTED_MAX_UTF8_BYTES,
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
import { getDocumentProxy } from "unpdf";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import type { StudyLibraryPaths } from "./StudyLibrary.ts";
import { readValidatedStudyObject } from "./StudyObjectStore.ts";

const decodeExtractedDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StudyExtractedDocument),
);
const encodeExtractedDocument = Schema.encodeEffect(Schema.fromJsonString(StudyExtractedDocument));

export const STUDY_EPUB_MAX_ENTRIES = 4_096;
export const STUDY_EPUB_MAX_ENTRY_EXPANDED_BYTES = 8 * 1_024 * 1_024;
export const STUDY_EPUB_MAX_TOTAL_EXPANDED_BYTES = 64 * 1_024 * 1_024;
export const STUDY_EPUB_MAX_COMPRESSION_RATIO = 100;
export const STUDY_EPUB_COMPRESSION_RATIO_MIN_BYTES = 64 * 1_024;
export const STUDY_EPUB_MAX_ENTRY_TEXT_CHARACTERS = 4 * 1_024 * 1_024;
export const STUDY_EPUB_MAX_TOTAL_TEXT_CHARACTERS = 16 * 1_024 * 1_024;
export const STUDY_EPUB_MAX_DOM_CHARACTERS = 2 * 1_024 * 1_024;
export const STUDY_EPUB_MAX_PARSED_TEXT_CHARACTERS = STUDY_EXTRACTED_MAX_SEGMENT_CHARACTERS;
export const STUDY_PDF_MAX_PAGES = STUDY_EXTRACTED_MAX_SEGMENTS;
export const STUDY_PDF_MAX_PAGE_TEXT_ITEMS = 250_000;
export const STUDY_PDF_MAX_PAGE_TEXT_CHARACTERS = STUDY_EXTRACTED_MAX_SEGMENT_CHARACTERS;

export interface StudyEpubArchiveEntryMetadata {
  readonly name: string;
  readonly compressedSize: number | undefined;
  readonly uncompressedSize: number | undefined;
}

function isSafeByteCount(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

export function validateStudyEpubArchiveMetadata(
  entries: ReadonlyArray<StudyEpubArchiveEntryMetadata>,
): void {
  if (entries.length > STUDY_EPUB_MAX_ENTRIES) {
    throw new Error(
      `EPUB archive entry count ${entries.length} exceeds ${STUDY_EPUB_MAX_ENTRIES}.`,
    );
  }

  let totalExpandedBytes = 0;
  for (const entry of entries) {
    if (!isSafeByteCount(entry.compressedSize) || !isSafeByteCount(entry.uncompressedSize)) {
      throw new Error(`EPUB entry '${entry.name}' has invalid size metadata.`);
    }
    if (entry.uncompressedSize > STUDY_EPUB_MAX_ENTRY_EXPANDED_BYTES) {
      throw new Error(`EPUB entry '${entry.name}' exceeds the per-entry expanded byte limit.`);
    }
    totalExpandedBytes += entry.uncompressedSize;
    if (
      !Number.isSafeInteger(totalExpandedBytes) ||
      totalExpandedBytes > STUDY_EPUB_MAX_TOTAL_EXPANDED_BYTES
    ) {
      throw new Error("EPUB archive exceeds the total expanded byte limit.");
    }
    if (entry.uncompressedSize < STUDY_EPUB_COMPRESSION_RATIO_MIN_BYTES) continue;
    if (
      entry.compressedSize === 0 ||
      entry.uncompressedSize / entry.compressedSize > STUDY_EPUB_MAX_COMPRESSION_RATIO
    ) {
      throw new Error(`EPUB entry '${entry.name}' has a suspicious compression ratio.`);
    }
  }
}

export function validateStudyExtractedSegments(segments: ReadonlyArray<StudyTextSegment>): void {
  if (segments.length > STUDY_EXTRACTED_MAX_SEGMENTS) {
    throw new Error(`Extracted text exceeds the ${STUDY_EXTRACTED_MAX_SEGMENTS} segment limit.`);
  }
  let totalUtf8Bytes = 0;
  for (const segment of segments) {
    if (segment.text.length > STUDY_EXTRACTED_MAX_SEGMENT_CHARACTERS) {
      throw new Error(`Extracted segment '${segment.id}' exceeds the per-segment text limit.`);
    }
    totalUtf8Bytes += Buffer.byteLength(segment.text, "utf8");
    if (totalUtf8Bytes > STUDY_EXTRACTED_MAX_UTF8_BYTES) {
      throw new Error("Extracted document exceeds the aggregate UTF-8 text limit.");
    }
  }
}

type PendingStudyTextSegment = Omit<StudyTextSegment, "id" | "order"> & {
  readonly order?: number;
};

function makeSegmentCollector(document: StudyDocument) {
  const segments: StudyTextSegment[] = [];
  let totalUtf8Bytes = 0;
  return {
    segments,
    append(pending: PendingStudyTextSegment): void {
      if (segments.length >= STUDY_EXTRACTED_MAX_SEGMENTS) {
        throw new Error(
          `Extracted text exceeds the ${STUDY_EXTRACTED_MAX_SEGMENTS} segment limit.`,
        );
      }
      if (pending.text.length > STUDY_EXTRACTED_MAX_SEGMENT_CHARACTERS) {
        throw new Error("Extracted segment exceeds the per-segment text limit.");
      }
      totalUtf8Bytes += Buffer.byteLength(pending.text, "utf8");
      if (totalUtf8Bytes > STUDY_EXTRACTED_MAX_UTF8_BYTES) {
        throw new Error("Extracted document exceeds the aggregate UTF-8 text limit.");
      }
      const order = pending.order ?? segments.length;
      segments.push({
        ...pending,
        id: segmentId(document, order),
        order,
      });
    },
  };
}

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
  const collector = makeSegmentCollector(document);
  const headingPath: string[] = [document.title];
  let currentHeading = document.title;
  let lines: string[] = [];

  const flush = () => {
    const text = normalizeText(lines.join("\n"));
    if (text.length > 0) {
      collector.append({
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
  return collector.segments;
}

const extractPdfSegments = Effect.fn("StudyTextExtractor.extractPdf")(function* (
  document: StudyDocument,
  bytes: Uint8Array,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const pdf = await getDocumentProxy(bytes);
      try {
        if (
          !Number.isSafeInteger(pdf.numPages) ||
          pdf.numPages < 0 ||
          pdf.numPages > STUDY_PDF_MAX_PAGES
        ) {
          throw new Error(
            `PDF page count ${pdf.numPages} exceeds the ${STUDY_PDF_MAX_PAGES} page limit.`,
          );
        }
        const collector = makeSegmentCollector(document);
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          if (!Array.isArray(content.items)) {
            throw new Error(`PDF page ${pageNumber} returned invalid text content.`);
          }
          if (content.items.length > STUDY_PDF_MAX_PAGE_TEXT_ITEMS) {
            throw new Error(
              `PDF page ${pageNumber} exceeds the ${STUDY_PDF_MAX_PAGE_TEXT_ITEMS} text-item limit.`,
            );
          }
          let raw = "";
          let rawCharacters = 0;
          for (const item of content.items) {
            if (!("str" in item) || typeof item.str !== "string") continue;
            const endOfLine = item.hasEOL ? "\n" : "";
            rawCharacters += item.str.length + endOfLine.length;
            if (rawCharacters > STUDY_PDF_MAX_PAGE_TEXT_CHARACTERS) {
              throw new Error(`PDF page ${pageNumber} exceeds the per-page text character limit.`);
            }
            raw += item.str + endOfLine;
          }
          const text = normalizeText(raw);
          if (text.length === 0) continue;
          collector.append({
            order: pageNumber - 1,
            heading: `Page ${pageNumber}`,
            anchor: { type: "pdf-page", page: pageNumber },
            text,
          });
        }
        return collector.segments;
      } finally {
        await pdf.destroy();
      }
    },
    catch: (cause) =>
      new StudyTextExtractionError({
        operation: "extract",
        documentId: document.id,
        detail: "Could not extract text from the PDF.",
        cause,
      }),
  });
});

function textFromChapterHtml(raw: string): {
  readonly title: string | undefined;
  readonly text: string;
} {
  if (raw.length > STUDY_EPUB_MAX_DOM_CHARACTERS) {
    throw new Error("EPUB chapter exceeds the parsed DOM character limit.");
  }
  const html = loadHtml(raw);
  html("script, style, nav, svg").remove();
  const rawTitle = html("h1, h2, h3, title").first().text();
  if (rawTitle.length > STUDY_EPUB_MAX_PARSED_TEXT_CHARACTERS) {
    throw new Error("EPUB chapter title exceeds the parsed text character limit.");
  }
  const title = normalizeText(rawTitle);
  const blocks: string[] = [];
  let parsedCharacters = 0;
  for (const element of html("h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption").toArray()) {
    const block = normalizeText(html(element).text());
    if (block.length === 0) continue;
    parsedCharacters += block.length + (blocks.length === 0 ? 0 : 2);
    if (parsedCharacters > STUDY_EPUB_MAX_PARSED_TEXT_CHARACTERS) {
      throw new Error("EPUB chapter exceeds the parsed text character limit.");
    }
    blocks.push(block);
  }
  let text: string;
  if (blocks.length > 0) {
    text = normalizeText(blocks.join("\n\n"));
  } else {
    const body = html("body").text();
    if (body.length > STUDY_EPUB_MAX_PARSED_TEXT_CHARACTERS) {
      throw new Error("EPUB chapter exceeds the parsed text character limit.");
    }
    text = normalizeText(body);
  }
  if (text.length > STUDY_EPUB_MAX_PARSED_TEXT_CHARACTERS) {
    throw new Error("EPUB chapter exceeds the parsed text character limit.");
  }
  return { title: title.length > 0 ? title : undefined, text };
}

const extractEpubSegments = Effect.fn("StudyTextExtractor.extractEpub")(function* (
  document: StudyDocument,
  bytes: Uint8Array,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const archive = await JSZip.loadAsync(bytes);
      validateStudyEpubArchiveMetadata(
        Object.values(archive.files).map((entry) => {
          const data = (
            entry as typeof entry & {
              readonly _data?: {
                readonly compressedSize?: number;
                readonly uncompressedSize?: number;
              };
            }
          )._data;
          return {
            name: entry.name,
            compressedSize: entry.dir ? 0 : data?.compressedSize,
            uncompressedSize: entry.dir ? 0 : data?.uncompressedSize,
          };
        }),
      );
      let totalExpandedTextCharacters = 0;
      const readEntryText = async (entry: JSZip.JSZipObject, label: string) => {
        const raw = await entry.async("string");
        if (raw.length > STUDY_EPUB_MAX_ENTRY_TEXT_CHARACTERS) {
          throw new Error(`EPUB ${label} exceeds the per-entry text character limit.`);
        }
        totalExpandedTextCharacters += raw.length;
        if (totalExpandedTextCharacters > STUDY_EPUB_MAX_TOTAL_TEXT_CHARACTERS) {
          throw new Error("EPUB exceeds the total expanded text character limit.");
        }
        if (raw.length > STUDY_EPUB_MAX_DOM_CHARACTERS) {
          throw new Error(`EPUB ${label} exceeds the parsed DOM character limit.`);
        }
        return raw;
      };
      const containerFile = archive.file("META-INF/container.xml");
      if (!containerFile) throw new Error("EPUB container.xml is missing.");
      const container = loadHtml(await readEntryText(containerFile, "container"), {
        xmlMode: true,
      });
      const packagePath = container("rootfile").attr("full-path");
      if (!packagePath) throw new Error("EPUB package path is missing.");
      const packageFile = archive.file(packagePath);
      if (!packageFile) throw new Error("EPUB package file is missing.");
      const packageXml = loadHtml(await readEntryText(packageFile, "package"), { xmlMode: true });
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
      if (spineIds.length > STUDY_EXTRACTED_MAX_SEGMENTS) {
        throw new Error(`EPUB spine exceeds the ${STUDY_EXTRACTED_MAX_SEGMENTS} segment limit.`);
      }
      const collector = makeSegmentCollector(document);
      for (const [spineIndex, id] of spineIds.entries()) {
        const href = manifest.get(id);
        if (!href) continue;
        const decodedHref = decodeURIComponent(href.split("#")[0] ?? href);
        const archivePath = resolveArchivePath(packagePath, decodedHref);
        const chapterFile = archive.file(archivePath);
        if (!chapterFile) continue;
        const chapter = textFromChapterHtml(await readEntryText(chapterFile, "chapter"));
        if (chapter.text.length === 0) continue;
        collector.append({
          ...(chapter.title ? { heading: chapter.title } : {}),
          anchor: { type: "epub-spine", href, spineIndex },
          text: chapter.text,
        });
      }
      return collector.segments;
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
  const { bytes } = yield* readValidatedStudyObject(input.paths, input.document).pipe(
    Effect.mapError(
      (cause) =>
        new StudyTextExtractionError({
          operation: "read",
          documentId: input.document.id,
          detail: "The immutable study object failed identity and integrity validation.",
          cause,
        }),
    ),
  );
  const segments =
    input.document.format === "markdown"
      ? yield* Effect.try({
          try: () => {
            if (bytes.byteLength > STUDY_EXTRACTED_MAX_UTF8_BYTES) {
              throw new Error("Markdown source exceeds the aggregate UTF-8 text limit.");
            }
            return extractMarkdownSegments(input.document, new TextDecoder().decode(bytes));
          },
          catch: (cause) =>
            new StudyTextExtractionError({
              operation: "extract",
              documentId: input.document.id,
              detail: "Could not extract text from the Markdown document.",
              cause,
            }),
        })
      : input.document.format === "pdf"
        ? yield* extractPdfSegments(input.document, bytes)
        : yield* extractEpubSegments(input.document, bytes);
  yield* Effect.try({
    try: () => validateStudyExtractedSegments(segments),
    catch: (cause) =>
      new StudyTextExtractionError({
        operation: "extract",
        documentId: input.document.id,
        detail: "Extracted study text exceeds its resource limits.",
        cause,
      }),
  });
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
  const extracted = yield* decodeExtractedDocument(raw).pipe(
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
  yield* Effect.try({
    try: () => validateStudyExtractedSegments(extracted.segments),
    catch: (cause) =>
      new StudyTextExtractionError({
        operation: "read",
        documentId: document.id,
        detail: "Extracted study text exceeds its resource limits.",
        cause,
      }),
  });
  return extracted;
});
