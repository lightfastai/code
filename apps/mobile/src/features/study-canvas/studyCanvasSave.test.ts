import { describe, expect, it, vi } from "vite-plus/test";

import { createStudyCanvasRemovalCoordinator, finishStudyCanvas } from "./studyCanvasSave";

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

describe("study canvas removal coordinator", () => {
  it.each(["gesture", "system-back", "route-removal"])(
    "cancels the debounce, saves, then replays an immediate %s action",
    async (action) => {
      const events: string[] = [];
      let resolveSave!: () => void;
      const saveFinished = new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
      const coordinator = createStudyCanvasRemovalCoordinator<string>();

      const request = coordinator.request({
        action,
        cancelScheduledSave: () => events.push("cancel-debounce"),
        surface: {
          exportDrawing: () => {
            events.push("export");
            return Promise.resolve("drawing-base64");
          },
        },
        canvasId: "canvas-1",
        title: "Study notes",
        snapshot: { revision: 12 },
        save: async () => {
          events.push("save-start");
          await saveFinished;
          events.push("save-finish");
        },
        onReadyToRemove: (readyAction) => {
          events.push(`replay:${readyAction}`);
        },
      });

      expect(request.started).toBe(true);
      expect(events).toEqual(["cancel-debounce", "export"]);
      await Promise.resolve();
      expect(events).toEqual(["cancel-debounce", "export", "save-start"]);
      resolveSave();
      await request.completion;
      expect(events).toEqual([
        "cancel-debounce",
        "export",
        "save-start",
        "save-finish",
        `replay:${action}`,
      ]);
    },
  );

  it("keeps removal blocked on failure and allows the action to retry", async () => {
    const coordinator = createStudyCanvasRemovalCoordinator<string>();
    const exportDrawing = vi.fn(() => Promise.resolve("drawing-base64"));
    const onReadyToRemove = vi.fn();
    const failure = new Error("disk full");

    const failed = coordinator.request({
      action: "back",
      cancelScheduledSave: vi.fn(),
      surface: { exportDrawing },
      canvasId: "canvas-1",
      title: "Study notes",
      snapshot: { revision: 13 },
      save: () => Promise.reject(failure),
      onReadyToRemove,
    });
    await expect(failed.completion).rejects.toBe(failure);
    expect(onReadyToRemove).not.toHaveBeenCalled();

    const retried = coordinator.request({
      action: "back",
      cancelScheduledSave: vi.fn(),
      surface: { exportDrawing },
      canvasId: "canvas-1",
      title: "Study notes",
      snapshot: { revision: 13 },
      save: () => Promise.resolve(),
      onReadyToRemove,
    });
    expect(retried.started).toBe(true);
    await retried.completion;
    expect(exportDrawing).toHaveBeenCalledTimes(2);
    expect(onReadyToRemove).toHaveBeenCalledExactlyOnceWith("back");
  });

  it("coalesces repeated removal actions while durable save is pending", async () => {
    let resolveSave!: () => void;
    const saveFinished = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const coordinator = createStudyCanvasRemovalCoordinator<string>();
    const exportDrawing = vi.fn(() => Promise.resolve("drawing-base64"));
    const first = coordinator.request({
      action: "gesture",
      cancelScheduledSave: vi.fn(),
      surface: { exportDrawing },
      canvasId: "canvas-1",
      title: "Study notes",
      snapshot: { revision: 14 },
      save: () => saveFinished,
      onReadyToRemove: vi.fn(),
    });
    const repeated = coordinator.request({
      action: "system-back",
      cancelScheduledSave: vi.fn(),
      surface: { exportDrawing },
      canvasId: "canvas-1",
      title: "Study notes",
      snapshot: { revision: 14 },
      save: () => Promise.resolve(),
      onReadyToRemove: vi.fn(),
    });

    expect(first.started).toBe(true);
    expect(repeated).toEqual({ started: false, completion: first.completion });
    expect(exportDrawing).toHaveBeenCalledTimes(1);
    resolveSave();
    await first.completion;
  });
});
