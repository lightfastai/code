import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import { View } from "react-native";

import { NativeViewResolutionError } from "../../native/nativeViewResolutionError";
import type { StudyCanvasSurfaceHandle, StudyCanvasSurfaceProps } from "./StudyCanvasSurface.types";

const NATIVE_MODULE_NAME = "T3StudyCanvas";

interface ExpoGlobalWithViewConfig {
  readonly expo?: {
    getViewConfig?: (moduleName: string, viewName?: string) => unknown;
  };
}

let cachedView: ComponentType<StudyCanvasSurfaceProps> | undefined;
let resolutionFailed = false;

function resolveNativeStudyCanvas(): ComponentType<StudyCanvasSurfaceProps> | null {
  if (cachedView) return cachedView;
  if (resolutionFailed) return null;

  const config = (globalThis as typeof globalThis & ExpoGlobalWithViewConfig).expo?.getViewConfig?.(
    NATIVE_MODULE_NAME,
  );
  if (config == null) return null;

  try {
    cachedView = requireNativeView<StudyCanvasSurfaceProps>(NATIVE_MODULE_NAME);
  } catch (cause) {
    resolutionFailed = true;
    console.error(new NativeViewResolutionError({ nativeModuleName: NATIVE_MODULE_NAME, cause }));
    return null;
  }
  return cachedView ?? null;
}

export function hasNativeStudyCanvasSurface(): boolean {
  return resolveNativeStudyCanvas() !== null;
}

export function StudyCanvasSurface(props: StudyCanvasSurfaceProps) {
  const NativeView = resolveNativeStudyCanvas();
  if (!NativeView) return <View style={props.style} />;
  return <NativeView {...props} />;
}

export type { StudyCanvasSurfaceHandle };
