import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  STUDY_EXTRACTED_MAX_SEGMENT_CHARACTERS,
  STUDY_EXTRACTED_MAX_SEGMENTS,
  StudyExtractedDocument,
  StudyTextSegment,
} from "./study.ts";

const decodeSegment = Schema.decodeUnknownSync(StudyTextSegment);
const decodeDocument = Schema.decodeUnknownSync(StudyExtractedDocument);
const documentId = "a".repeat(64);
const segment = {
  id: "segment-0",
  order: 0,
  anchor: { type: "pdf-page" as const, page: 1 },
  text: "bounded",
};

describe("study extraction contracts", () => {
  it("accepts segment text at the character limit and rejects one character beyond it", () => {
    expect(
      decodeSegment({ ...segment, text: "x".repeat(STUDY_EXTRACTED_MAX_SEGMENT_CHARACTERS) }),
    ).toMatchObject({ id: "segment-0" });
    expect(() =>
      decodeSegment({
        ...segment,
        text: "x".repeat(STUDY_EXTRACTED_MAX_SEGMENT_CHARACTERS + 1),
      }),
    ).toThrow();
  });

  it("accepts the segment-count limit and rejects one segment beyond it", () => {
    const extractedAt = "2026-07-17T00:00:00.000Z";
    expect(
      decodeDocument({
        version: 1,
        documentId,
        segments: Array.from({ length: STUDY_EXTRACTED_MAX_SEGMENTS }, (_, order) => ({
          ...segment,
          id: `segment-${order}`,
          order,
        })),
        extractedAt,
      }),
    ).toMatchObject({ documentId });
    expect(() =>
      decodeDocument({
        version: 1,
        documentId,
        segments: Array.from({ length: STUDY_EXTRACTED_MAX_SEGMENTS + 1 }, (_, order) => ({
          ...segment,
          id: `segment-${order}`,
          order,
        })),
        extractedAt,
      }),
    ).toThrow();
  });
});
