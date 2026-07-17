import type { StudyCanvasRegion } from "@t3tools/contracts";

import type { StudyCanvasSurfaceSnapshot } from "./StudyCanvasSurface.types";

export interface StudyCanvasSaveInput {
  readonly canvasId: string;
  readonly title: string;
  readonly revision: number;
  readonly drawingDataBase64: string;
  readonly contentBounds?: StudyCanvasRegion;
}

interface StudyCanvasExportSurface {
  readonly exportSnapshot: () => Promise<StudyCanvasSurfaceSnapshot>;
}

interface StudyCanvasRemovalSurface {
  readonly freezeAndExportSnapshot: () => Promise<StudyCanvasSurfaceSnapshot>;
  readonly unfreeze: () => Promise<void>;
}

async function persistExportedSnapshot(input: {
  readonly canvasId: string;
  readonly title: string;
  readonly exportedSnapshot: Promise<StudyCanvasSurfaceSnapshot>;
  readonly save: (snapshot: StudyCanvasSaveInput) => Promise<unknown>;
}): Promise<void> {
  const snapshot = await input.exportedSnapshot;
  await input.save({
    canvasId: input.canvasId,
    title: input.title,
    revision: snapshot.revision,
    drawingDataBase64: snapshot.drawingDataBase64,
    ...(snapshot.contentBounds ? { contentBounds: snapshot.contentBounds } : {}),
  });
}

export async function saveStudyCanvasSurfaceSnapshot(input: {
  readonly surface: StudyCanvasExportSurface;
  readonly canvasId: string;
  readonly title: string;
  readonly save: (snapshot: StudyCanvasSaveInput) => Promise<unknown>;
}): Promise<void> {
  // Invoke native export before yielding. Native returns bytes and revision
  // from one snapshot so asynchronous bridge timing cannot pair mismatched data.
  const exportedSnapshot = input.surface.exportSnapshot();
  await persistExportedSnapshot({
    canvasId: input.canvasId,
    title: input.title,
    exportedSnapshot,
    save: input.save,
  });
}

export async function finishStudyCanvas(input: {
  readonly surface: StudyCanvasRemovalSurface;
  readonly canvasId: string;
  readonly title: string;
  readonly save: (snapshot: StudyCanvasSaveInput) => Promise<unknown>;
  readonly onSaved: () => void | Promise<void>;
}): Promise<void> {
  // This is one native operation: it freezes every mutation path before
  // reading drawing bytes, revision, and bounds from the same native state.
  const exportedSnapshot = input.surface.freezeAndExportSnapshot();
  try {
    await persistExportedSnapshot({
      canvasId: input.canvasId,
      title: input.title,
      exportedSnapshot,
      save: input.save,
    });
    await input.onSaved();
  } catch (cause) {
    await input.surface.unfreeze();
    throw cause;
  }
}

export type StudyCanvasRemovalRequest<Action> = {
  readonly surface: StudyCanvasRemovalSurface;
  readonly canvasId: string;
  readonly title: string;
  readonly save: (snapshot: StudyCanvasSaveInput) => Promise<unknown>;
  readonly action: Action;
  readonly cancelScheduledSave: () => void;
  readonly onReadyToRemove: (action: Action) => void | Promise<void>;
};

export type StudyCanvasRemovalRequestResult =
  | { readonly started: true; readonly completion: Promise<void> }
  | { readonly started: false; readonly completion: Promise<void> };

export function createStudyCanvasRemovalCoordinator<Action>(): {
  readonly request: (input: StudyCanvasRemovalRequest<Action>) => StudyCanvasRemovalRequestResult;
} {
  let activeCompletion: Promise<void> | null = null;

  return {
    request(input) {
      if (activeCompletion) {
        return { started: false, completion: activeCompletion };
      }

      const completion = (async () => {
        input.cancelScheduledSave();
        await finishStudyCanvas({
          surface: input.surface,
          canvasId: input.canvasId,
          title: input.title,
          save: input.save,
          onSaved: () => input.onReadyToRemove(input.action),
        });
      })();
      activeCompletion = completion;
      void completion.then(
        () => {
          if (activeCompletion === completion) activeCompletion = null;
        },
        () => {
          if (activeCompletion === completion) activeCompletion = null;
        },
      );
      return { started: true, completion };
    },
  };
}
