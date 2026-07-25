import type { StudyCanvasRegion } from "@t3tools/contracts";
import type { Ref } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";

export interface StudyCanvasDrawingChangeEvent {
  readonly revision: number;
  readonly contentBounds?: StudyCanvasRegion;
}

export interface StudyCanvasSelectionChangeEvent {
  readonly selected: boolean;
  readonly rect?: StudyCanvasRegion;
  readonly revision?: number;
}

export interface StudyCanvasRegionExport {
  readonly pngBase64: string;
  readonly rect?: StudyCanvasRegion;
  readonly revision?: number;
}

export interface StudyCanvasSurfaceSnapshot {
  readonly drawingDataBase64: string;
  readonly revision: number;
  readonly contentBounds?: StudyCanvasRegion;
}

export interface StudyCanvasSurfaceHandle {
  readonly loadDrawing: (dataBase64: string, revision: number) => Promise<void>;
  readonly exportSnapshot: () => Promise<StudyCanvasSurfaceSnapshot>;
  readonly freezeAndExportSnapshot: () => Promise<StudyCanvasSurfaceSnapshot>;
  readonly unfreeze: () => Promise<void>;
  readonly exportRegion: () => Promise<StudyCanvasRegionExport>;
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
  readonly clear: () => Promise<void>;
  readonly clearSelection: () => Promise<void>;
}

export interface StudyCanvasSurfaceProps extends ViewProps {
  readonly ref?: Ref<StudyCanvasSurfaceHandle>;
  readonly selectionMode: boolean;
  readonly onDrawingChange?: (event: NativeSyntheticEvent<StudyCanvasDrawingChangeEvent>) => void;
  readonly onSelectionChange?: (
    event: NativeSyntheticEvent<StudyCanvasSelectionChangeEvent>,
  ) => void;
}
