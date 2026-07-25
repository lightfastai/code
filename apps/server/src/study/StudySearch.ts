import type { StudySearchHit, StudySearchInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readStudyLibraryIndex, type StudyLibraryPaths } from "./StudyLibrary.ts";
import { readExtractedStudyDocument } from "./StudyTextExtractor.ts";

function tokenize(value: string): string[] {
  return Array.from(
    new Set(
      value
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length > 1),
    ),
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor < haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + needle.length;
  }
  return count;
}

function excerptAroundMatch(text: string, tokens: ReadonlyArray<string>): string {
  const lower = text.toLocaleLowerCase();
  const firstMatch = tokens.reduce((best, token) => {
    const index = lower.indexOf(token);
    return index >= 0 && (best < 0 || index < best) ? index : best;
  }, -1);
  const center = firstMatch >= 0 ? firstMatch : 0;
  const start = Math.max(0, center - 320);
  const end = Math.min(text.length, start + 1_200);
  const excerpt = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
}

export const searchStudyLibrary = Effect.fn("StudySearch.search")(function* (
  paths: StudyLibraryPaths,
  input: StudySearchInput,
) {
  const tokens = tokenize(input.query);
  if (tokens.length === 0) return [];
  const index = yield* readStudyLibraryIndex(paths);
  const documentIds = input.documentIds ? new Set(input.documentIds) : null;
  const requestedTags = input.tags?.map((tag) => tag.trim().toLocaleLowerCase()) ?? [];
  const documents = index.documents.filter(
    (document) =>
      (!documentIds || documentIds.has(document.id)) &&
      requestedTags.every((tag) => document.tags.includes(tag)),
  );
  const hits: StudySearchHit[] = [];

  for (const document of documents) {
    const extracted = yield* readExtractedStudyDocument(paths, document).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!extracted) continue;
    for (const segment of extracted.segments) {
      const lowerText = segment.text.toLocaleLowerCase();
      const lowerHeading = segment.heading?.toLocaleLowerCase() ?? "";
      const matchedTokens = tokens.filter(
        (token) => lowerText.includes(token) || lowerHeading.includes(token),
      );
      if (matchedTokens.length === 0) continue;
      const coverage = matchedTokens.length / tokens.length;
      const frequency = matchedTokens.reduce(
        (score, token) => score + Math.min(8, countOccurrences(lowerText, token)),
        0,
      );
      const headingBoost = matchedTokens.reduce(
        (score, token) => score + (lowerHeading.includes(token) ? 3 : 0),
        0,
      );
      hits.push({
        documentId: document.id,
        documentTitle: document.title,
        documentFormat: document.format,
        anchor: segment.anchor,
        ...(segment.heading ? { heading: segment.heading } : {}),
        excerpt: excerptAroundMatch(segment.text, matchedTokens),
        score: coverage * 10 + frequency + headingBoost,
      });
    }
  }

  return hits
    .sort(
      (left, right) =>
        right.score - left.score || left.documentTitle.localeCompare(right.documentTitle),
    )
    .slice(0, input.limit ?? 8);
});
