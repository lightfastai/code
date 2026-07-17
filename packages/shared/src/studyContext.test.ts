import { describe, expect, it } from "vite-plus/test";
import type { StudyContextCapsule, StudyDocument } from "@t3tools/contracts";

import {
  appendStudyContextCapsulesToPrompt,
  appendStudyDocumentsToPrompt,
  narrowStudyDocumentIds,
  normalizeStudyDocumentIds,
  selectedStudyDocumentIds,
} from "./studyContext.js";

const document: StudyDocument = {
  id: "a".repeat(64),
  sha256: "a".repeat(64),
  format: "pdf",
  title: "Linear Algebra Done Right",
  fileName: "linear-algebra.pdf",
  objectKey: `objects/aa/${"a".repeat(64)}.pdf`,
  sizeBytes: 123,
  tags: ["math"],
  importedAt: "2026-07-15T00:00:00.000Z",
};

describe("appendStudyDocumentsToPrompt", () => {
  it("leaves prompts unchanged without selected documents", () => {
    expect(appendStudyDocumentsToPrompt("Explain eigenvectors", [])).toBe("Explain eigenvectors");
  });

  it("adds a bounded machine-readable grounding scope", () => {
    const result = appendStudyDocumentsToPrompt("Explain eigenvectors", [document]);

    expect(result).toContain("Explain eigenvectors");
    expect(result).toContain(document.id);
    expect(result).toContain(document.title);
    expect(result).toContain("study_library_search");
    expect(result).not.toContain(document.objectKey);
  });
});

describe("study document ID scope", () => {
  it("normalizes client selections and only permits equal or narrower requests", () => {
    const other = { ...document, id: "b".repeat(64), sha256: "b".repeat(64) };

    expect(selectedStudyDocumentIds([other, document, other])).toEqual([document.id, other.id]);
    expect(normalizeStudyDocumentIds([other.id, document.id, other.id])).toEqual([
      document.id,
      other.id,
    ]);
    expect(narrowStudyDocumentIds([document.id, other.id], [other.id])).toEqual([other.id]);
    expect(narrowStudyDocumentIds([document.id], [other.id])).toBeNull();
  });
});

describe("appendStudyContextCapsulesToPrompt", () => {
  it("adds typed canvas-region context without embedding image data", () => {
    const capsule: StudyContextCapsule = {
      id: "capsule-1",
      selections: [
        {
          canvasId: "canvas-1",
          anchor: {
            type: "canvas-region",
            rect: { x: 10, y: 20, width: 300, height: 180 },
            revision: 7,
          },
          snapshotName: "canvas-selection.png",
        },
      ],
      note: "Explain this diagram",
      createdAt: "2026-07-15T00:00:00.000Z",
    };

    const result = appendStudyContextCapsulesToPrompt("Explain this diagram", [capsule]);

    expect(result).toContain("study_context_capsules");
    expect(result).toContain("canvas-region");
    expect(result).toContain("canvas-selection.png");
    expect(result).not.toContain("base64");
  });
});
