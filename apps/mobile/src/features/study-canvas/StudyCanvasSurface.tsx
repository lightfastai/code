import { View } from "react-native";

import type { StudyCanvasSurfaceHandle, StudyCanvasSurfaceProps } from "./StudyCanvasSurface.types";

export function hasNativeStudyCanvasSurface(): boolean {
  return false;
}

export function StudyCanvasSurface(props: StudyCanvasSurfaceProps) {
  return <View style={props.style} />;
}

export type { StudyCanvasSurfaceHandle };
