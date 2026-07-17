import type { StudyCanvasRegion } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createStudyCanvasRemovalCoordinator,
  finishStudyCanvas,
  saveStudyCanvasSurfaceSnapshot,
} from "./studyCanvasSave";

const contentBounds = {
  x: 10,
  y: 20,
  width: 300,
  height: 200,
} satisfies StudyCanvasRegion;

describe("saveStudyCanvasSurfaceSnapshot", () => {
  it("persists drawing bytes, revision, and bounds from one native snapshot", async () => {
    const exportSnapshot = vi.fn(() =>
      Promise.resolve({
        drawingDataBase64: "drawing-at-42",
        revision: 42,
        contentBounds,
      }),
    );
    const save = vi.fn(() => Promise.resolve());

    const completion = saveStudyCanvasSurfaceSnapshot({
      surface: { exportSnapshot },
      canvasId: "canvas-1",
      title: "Study notes",
      save,
    });

    expect(exportSnapshot).toHaveBeenCalledTimes(1);
    await completion;
    expect(save).toHaveBeenCalledExactlyOnceWith({
      canvasId: "canvas-1",
      title: "Study notes",
      revision: 42,
      drawingDataBase64: "drawing-at-42",
      contentBounds,
    });
  });
});

describe("finishStudyCanvas", () => {
  it("synchronously starts a frozen atomic export and durably saves it before navigation", async () => {
    const events: string[] = [];
    let resolveExport!: (snapshot: {
      readonly drawingDataBase64: string;
      readonly revision: number;
    }) => void;
    const exported = new Promise<{
      readonly drawingDataBase64: string;
      readonly revision: number;
    }>((resolve) => {
      resolveExport = resolve;
    });
    const freezeAndExportSnapshot = vi.fn(() => {
      events.push("freeze-export");
      return exported;
    });
    const save = vi.fn(
      async (input: { readonly drawingDataBase64: string; readonly revision: number }) => {
        events.push(`save:${input.drawingDataBase64}@${input.revision}`);
      },
    );
    const onSaved = vi.fn(() => {
      events.push("navigate");
    });

    const completion = finishStudyCanvas({
      surface: {
        freezeAndExportSnapshot,
        unfreeze: vi.fn(() => Promise.resolve()),
      },
      canvasId: "canvas-1",
      title: "Study notes",
      save,
      onSaved,
    });

    expect(freezeAndExportSnapshot).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["freeze-export"]);

    resolveExport({ drawingDataBase64: "drawing-at-43", revision: 43 });
    await completion;
    expect(save).toHaveBeenCalledExactlyOnceWith({
      canvasId: "canvas-1",
      title: "Study notes",
      revision: 43,
      drawingDataBase64: "drawing-at-43",
    });
    expect(events).toEqual(["freeze-export", "save:drawing-at-43@43", "navigate"]);
  });

  it("unfreezes and keeps the route open when export or persistence fails", async () => {
    const failure = new Error("disk full");
    const unfreeze = vi.fn(() => Promise.resolve());
    const onSaved = vi.fn();

    await expect(
      finishStudyCanvas({
        surface: {
          freezeAndExportSnapshot: () =>
            Promise.resolve({ drawingDataBase64: "drawing-at-7", revision: 7 }),
          unfreeze,
        },
        canvasId: "canvas-1",
        title: "Study notes",
        save: () => Promise.reject(failure),
        onSaved,
      }),
    ).rejects.toBe(failure);
    expect(unfreeze).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("unfreezes when the native atomic export fails", async () => {
    const failure = new Error("native export failed");
    const unfreeze = vi.fn(() => Promise.resolve());
    const save = vi.fn(() => Promise.resolve());

    await expect(
      finishStudyCanvas({
        surface: {
          freezeAndExportSnapshot: () => Promise.reject(failure),
          unfreeze,
        },
        canvasId: "canvas-1",
        title: "Study notes",
        save,
        onSaved: vi.fn(),
      }),
    ).rejects.toBe(failure);
    expect(unfreeze).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("study canvas removal coordinator", () => {
  it.each(["gesture", "system-back", "route-removal"])(
    "freezes, saves, then replays an immediate %s action without unfreezing",
    async (action) => {
      const events: string[] = [];
      let resolveSave!: () => void;
      const saveFinished = new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
      const coordinator = createStudyCanvasRemovalCoordinator<string>();
      const unfreeze = vi.fn(() => {
        events.push("unfreeze");
        return Promise.resolve();
      });

      const request = coordinator.request({
        action,
        cancelScheduledSave: () => events.push("cancel-debounce"),
        surface: {
          freezeAndExportSnapshot: () => {
            events.push("freeze-export");
            return Promise.resolve({ drawingDataBase64: "drawing-at-12", revision: 12 });
          },
          unfreeze,
        },
        canvasId: "canvas-1",
        title: "Study notes",
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
      expect(events).toEqual(["cancel-debounce", "freeze-export"]);
      await Promise.resolve();
      expect(events).toEqual(["cancel-debounce", "freeze-export", "save-start"]);
      resolveSave();
      await request.completion;
      expect(events).toEqual([
        "cancel-debounce",
        "freeze-export",
        "save-start",
        "save-finish",
        `replay:${action}`,
      ]);
      expect(unfreeze).not.toHaveBeenCalled();
    },
  );

  it("makes post-request strokes and toolbar mutations no-ops immediately", async () => {
    let frozen = false;
    let mutationCount = 0;
    let resolveExport!: (snapshot: {
      readonly drawingDataBase64: string;
      readonly revision: number;
    }) => void;
    const exported = new Promise<{
      readonly drawingDataBase64: string;
      readonly revision: number;
    }>((resolve) => {
      resolveExport = resolve;
    });
    const mutate = () => {
      if (!frozen) mutationCount += 1;
    };
    const surface = {
      freezeAndExportSnapshot: () => {
        frozen = true;
        return exported;
      },
      unfreeze: () => {
        frozen = false;
        return Promise.resolve();
      },
      stroke: mutate,
      selectTool: mutate,
      undo: mutate,
      redo: mutate,
      clear: mutate,
      clearSelection: mutate,
    };
    const coordinator = createStudyCanvasRemovalCoordinator<string>();

    const request = coordinator.request({
      action: "back",
      cancelScheduledSave: vi.fn(),
      surface,
      canvasId: "canvas-1",
      title: "Study notes",
      save: () => Promise.resolve(),
      onReadyToRemove: vi.fn(),
    });

    surface.stroke();
    surface.selectTool();
    surface.undo();
    surface.redo();
    surface.clear();
    surface.clearSelection();
    expect(frozen).toBe(true);
    expect(mutationCount).toBe(0);

    resolveExport({ drawingDataBase64: "drawing-at-15", revision: 15 });
    await request.completion;
  });

  it("keeps the surface frozen through the replay frame", async () => {
    let frozen = false;
    let replayFrame: (() => void) | undefined;
    const unfreeze = vi.fn(() => {
      frozen = false;
      return Promise.resolve();
    });
    const coordinator = createStudyCanvasRemovalCoordinator<string>();

    const request = coordinator.request({
      action: "gesture",
      cancelScheduledSave: vi.fn(),
      surface: {
        freezeAndExportSnapshot: () => {
          frozen = true;
          return Promise.resolve({ drawingDataBase64: "drawing-at-16", revision: 16 });
        },
        unfreeze,
      },
      canvasId: "canvas-1",
      title: "Study notes",
      save: () => Promise.resolve(),
      onReadyToRemove: () => {
        expect(frozen).toBe(true);
        replayFrame = () => expect(frozen).toBe(true);
      },
    });

    await request.completion;
    expect(frozen).toBe(true);
    replayFrame?.();
    expect(unfreeze).not.toHaveBeenCalled();
  });

  it("unfreezes on failure and allows the action to retry", async () => {
    const coordinator = createStudyCanvasRemovalCoordinator<string>();
    let frozen = false;
    const freezeAndExportSnapshot = vi.fn(() => {
      frozen = true;
      return Promise.resolve({ drawingDataBase64: "drawing-at-13", revision: 13 });
    });
    const unfreeze = vi.fn(() => {
      frozen = false;
      return Promise.resolve();
    });
    const onReadyToRemove = vi.fn();
    const failure = new Error("disk full");
    const surface = { freezeAndExportSnapshot, unfreeze };

    const failed = coordinator.request({
      action: "back",
      cancelScheduledSave: vi.fn(),
      surface,
      canvasId: "canvas-1",
      title: "Study notes",
      save: () => Promise.reject(failure),
      onReadyToRemove,
    });
    await expect(failed.completion).rejects.toBe(failure);
    expect(frozen).toBe(false);
    expect(unfreeze).toHaveBeenCalledTimes(1);
    expect(onReadyToRemove).not.toHaveBeenCalled();

    const retried = coordinator.request({
      action: "back",
      cancelScheduledSave: vi.fn(),
      surface,
      canvasId: "canvas-1",
      title: "Study notes",
      save: () => Promise.resolve(),
      onReadyToRemove,
    });
    expect(retried.started).toBe(true);
    await retried.completion;
    expect(freezeAndExportSnapshot).toHaveBeenCalledTimes(2);
    expect(onReadyToRemove).toHaveBeenCalledExactlyOnceWith("back");
    expect(frozen).toBe(true);
  });

  it("coalesces repeated removal actions while durable save is pending", async () => {
    let resolveSave!: () => void;
    const saveFinished = new Promise<void>((resolve) => {
      resolveSave = resolve;
    });
    const coordinator = createStudyCanvasRemovalCoordinator<string>();
    const freezeAndExportSnapshot = vi.fn(() =>
      Promise.resolve({ drawingDataBase64: "drawing-at-14", revision: 14 }),
    );
    const surface = {
      freezeAndExportSnapshot,
      unfreeze: vi.fn(() => Promise.resolve()),
    };
    const first = coordinator.request({
      action: "gesture",
      cancelScheduledSave: vi.fn(),
      surface,
      canvasId: "canvas-1",
      title: "Study notes",
      save: () => saveFinished,
      onReadyToRemove: vi.fn(),
    });
    const repeated = coordinator.request({
      action: "system-back",
      cancelScheduledSave: vi.fn(),
      surface,
      canvasId: "canvas-1",
      title: "Study notes",
      save: () => Promise.resolve(),
      onReadyToRemove: vi.fn(),
    });

    expect(first.started).toBe(true);
    expect(repeated).toEqual({ started: false, completion: first.completion });
    expect(freezeAndExportSnapshot).toHaveBeenCalledTimes(1);
    resolveSave();
    await first.completion;
  });
});
