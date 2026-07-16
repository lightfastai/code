import { describe, expect, it } from "@effect/vitest";

import {
  appendStudyCanvasSnapshotOperation,
  createStudyCanvasDocument,
  decodeStudyCanvasDocument,
  STUDY_CANVAS_MAX_SNAPSHOT_OPERATIONS,
  studyCanvasIdForThread,
} from "./studyCanvasModel";

function digest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

describe("study canvas model", () => {
  it("derives a stable bounded canvas id for a thread", () => {
    const first = studyCanvasIdForThread("local-main", "thread-123");
    expect(first).toBe(studyCanvasIdForThread("local-main", "thread-123"));
    expect(first).not.toBe(studyCanvasIdForThread("local-main", "thread-456"));
    expect(first).toMatch(/^thread-[0-9a-f]{16}$/);
  });

  it("appends immutable snapshots, deduplicates content, and prunes old history", () => {
    let document = createStudyCanvasDocument({
      canvasId: "canvas-1",
      title: "Eigenvectors",
      now: "2026-07-15T00:00:00.000Z",
    });
    const pruned: string[] = [];

    for (let index = 1; index <= STUDY_CANVAS_MAX_SNAPSHOT_OPERATIONS + 2; index += 1) {
      const result = appendStudyCanvasSnapshotOperation(document, {
        operationId: `operation-${index}`,
        revision: index,
        digest: digest(index),
        snapshotFileName: `${index}-${digest(index).slice(0, 12)}.drawing`,
        now: `2026-07-15T00:00:${String(index).padStart(2, "0")}.000Z`,
      });
      document = result.document;
      pruned.push(...result.prunedSnapshotFileNames);
    }

    expect(document.operations).toHaveLength(STUDY_CANVAS_MAX_SNAPSHOT_OPERATIONS);
    expect(document.operations[0]?.sequence).toBe(3);
    expect(document.operations.at(-1)?.revision).toBe(STUDY_CANVAS_MAX_SNAPSHOT_OPERATIONS + 2);
    expect(pruned).toHaveLength(2);

    const duplicate = appendStudyCanvasSnapshotOperation(document, {
      operationId: "duplicate",
      revision: 999,
      digest: document.operations.at(-1)!.digest,
      snapshotFileName: "duplicate.drawing",
      now: "2026-07-15T01:00:00.000Z",
    });
    expect(duplicate.document).toBe(document);
    expect(duplicate.prunedSnapshotFileNames).toEqual([]);
  });

  it("rejects unsafe snapshot paths", () => {
    const document = createStudyCanvasDocument({
      canvasId: "canvas-1",
      title: "Notes",
      now: "2026-07-15T00:00:00.000Z",
    });

    expect(() =>
      decodeStudyCanvasDocument({
        ...document,
        operations: [
          {
            id: "operation-1",
            sequence: 1,
            type: "drawing-snapshot",
            revision: 1,
            digest: digest(1),
            snapshotFileName: "../escape.drawing",
            createdAt: "2026-07-15T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });
});
