import type { StudyCanvasRegion } from "@t3tools/contracts";

export interface StudyCanvasSaveSnapshot {
  readonly revision: number;
  readonly contentBounds?: StudyCanvasRegion;
}

export interface StudyCanvasSaveInput {
  readonly canvasId: string;
  readonly title: string;
  readonly revision: number;
  readonly drawingDataBase64: string;
  readonly contentBounds?: StudyCanvasRegion;
}

interface StudyCanvasExportSurface {
  readonly exportDrawing: () => Promise<string>;
}

export async function saveStudyCanvasSurfaceSnapshot(input: {
  readonly surface: StudyCanvasExportSurface;
  readonly canvasId: string;
  readonly title: string;
  readonly snapshot: StudyCanvasSaveSnapshot;
  readonly save: (snapshot: StudyCanvasSaveInput) => Promise<unknown>;
}): Promise<void> {
  // Invoke the native export before yielding so callers can capture the view
  // while its ref is still live during an explicit Done action.
  const drawingExport = input.surface.exportDrawing();
  const drawingDataBase64 = await drawingExport;
  await input.save({
    canvasId: input.canvasId,
    title: input.title,
    revision: input.snapshot.revision,
    drawingDataBase64,
    ...(input.snapshot.contentBounds ? { contentBounds: input.snapshot.contentBounds } : {}),
  });
}

export async function finishStudyCanvas(
  input: Parameters<typeof saveStudyCanvasSurfaceSnapshot>[0] & {
    readonly onSaved: () => void | Promise<void>;
  },
): Promise<void> {
  await saveStudyCanvasSurfaceSnapshot(input);
  await input.onSaved();
}
