import { describe, expect, it, vi } from "vite-plus/test";

import { finishStudyCanvas } from "./studyCanvasSave";

describe("finishStudyCanvas", () => {
  it("captures an immediate edit, durably saves its revision, then navigates", async () => {
    const events: string[] = [];
    const exportDrawing = vi.fn(() => {
      events.push("export");
      return Promise.resolve("drawing-base64");
    });
    const save = vi.fn(async (input: { readonly revision: number }) => {
      events.push(`save:${input.revision}`);
    });
    const onSaved = vi.fn(() => {
      events.push("navigate");
    });

    const completion = finishStudyCanvas({
      surface: { exportDrawing },
      canvasId: "canvas-1",
      title: "Study notes",
      snapshot: { revision: 42 },
      save,
      onSaved,
    });

    expect(exportDrawing).toHaveBeenCalledTimes(1);
    await completion;
    expect(save).toHaveBeenCalledWith({
      canvasId: "canvas-1",
      title: "Study notes",
      revision: 42,
      drawingDataBase64: "drawing-base64",
    });
    expect(events).toEqual(["export", "save:42", "navigate"]);
  });

  it("keeps the route open when durable persistence fails", async () => {
    const failure = new Error("disk full");
    const onSaved = vi.fn();

    await expect(
      finishStudyCanvas({
        surface: { exportDrawing: () => Promise.resolve("drawing-base64") },
        canvasId: "canvas-1",
        title: "Study notes",
        snapshot: { revision: 7 },
        save: () => Promise.reject(failure),
        onSaved,
      }),
    ).rejects.toBe(failure);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
