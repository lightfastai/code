import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const routeSource = NodeFS.readFileSync(new URL("./StudyCanvasRouteScreen.tsx", import.meta.url), {
  encoding: "utf8",
});
const typesSource = NodeFS.readFileSync(new URL("./StudyCanvasSurface.types.ts", import.meta.url), {
  encoding: "utf8",
});
const moduleSource = NodeFS.readFileSync(
  new URL("../../../modules/t3-study-canvas/ios/T3StudyCanvasModule.swift", import.meta.url),
  { encoding: "utf8" },
);
const viewSource = NodeFS.readFileSync(
  new URL("../../../modules/t3-study-canvas/ios/T3StudyCanvasView.swift", import.meta.url),
  { encoding: "utf8" },
);

describe("native study canvas revision bridge", () => {
  it("passes the persisted revision through every loadDrawing bridge layer", () => {
    expect(typesSource).toMatch(
      /loadDrawing:\s*\(dataBase64:\s*string,\s*revision:\s*number\)\s*=>\s*Promise<void>/,
    );
    expect(routeSource).toContain("loadDrawing(loaded.drawingDataBase64, loaded.revision)");
    expect(moduleSource).toMatch(
      /AsyncFunction\("loadDrawing"\).*dataBase64:\s*String,\s*revision:\s*Int.*loadDrawing\(dataBase64:\s*dataBase64,\s*revision:\s*revision\)/s,
    );
    expect(viewSource).toMatch(
      /func loadDrawing\(dataBase64:\s*String,\s*revision:\s*Int\) throws[\s\S]*self\.revision\s*=\s*max\(0,\s*revision\)/,
    );
  });

  it("suppresses restoration callbacks so the next real edit emits N plus one", () => {
    expect(viewSource).toMatch(/canvasViewDrawingDidChange[\s\S]*guard !isRestoringDrawing/);
    expect(viewSource).toMatch(/private func drawingDidChange\(\)[\s\S]*revision \+= 1/);
  });
});

describe("study canvas route removal guard", () => {
  it("guards every native route removal and replays only the saved action", () => {
    expect(routeSource).toContain(
      "usePreventRemove(nativeAvailable && pendingRemovalAction === null",
    );
    expect(routeSource).toContain("handlePreventedRemoval(data.action)");
    expect(routeSource).toContain("navigation.dispatch(pendingRemovalAction)");
    expect(routeSource).toMatch(/onReadyToRemove:[\s\S]*setPendingRemovalAction\(readyAction\)/);
  });

  it("uses the native atomic freeze snapshot and keeps JS mutation paths disabled", () => {
    expect(typesSource).toMatch(
      /freezeAndExportSnapshot:\s*\(\)\s*=>\s*Promise<StudyCanvasSurfaceSnapshot>/,
    );
    expect(typesSource).toMatch(/unfreeze:\s*\(\)\s*=>\s*Promise<void>/);
    expect(routeSource).toContain("if (removalPendingRef.current) return;");
    expect(routeSource).toMatch(/disabled=\{finishing\}[\s\S]*accessibilityLabel="Undo drawing"/);
    expect(routeSource).toMatch(/accessibilityLabel="Undo drawing"[\s\S]*disabled=\{finishing\}/);
    expect(routeSource).toMatch(/accessibilityLabel="Redo drawing"[\s\S]*disabled=\{finishing\}/);
    expect(routeSource).toMatch(/accessibilityLabel="Clear drawing"[\s\S]*disabled=\{finishing\}/);
  });
});

describe("native study canvas removal freeze", () => {
  it("exports drawing bytes, revision, and bounds atomically after freezing", () => {
    expect(moduleSource).toMatch(
      /AsyncFunction\("freezeAndExportSnapshot"\)[\s\S]*view\.freezeAndExportSnapshot\(\)/,
    );
    expect(moduleSource).toMatch(/AsyncFunction\("unfreeze"\)[\s\S]*view\.unfreeze\(\)/);
    expect(viewSource).toMatch(
      /func freezeAndExportSnapshot\(\)[\s\S]*setFrozen\(true\)[\s\S]*drawingSnapshotPayload\(\)/,
    );
    expect(viewSource).toMatch(
      /private func drawingSnapshotPayload\(\)[\s\S]*"drawingDataBase64"[\s\S]*"revision": revision[\s\S]*"contentBounds"/,
    );
  });

  it("blocks PencilKit, tool selection, undo, redo, clear, and selection mutations while frozen", () => {
    expect(viewSource).toMatch(/func setSelectionMode[\s\S]*guard !isFrozen/);
    expect(viewSource).toMatch(/func loadDrawing[\s\S]*guard !isFrozen/);
    expect(viewSource).toMatch(/func undo\(\)[\s\S]*guard !isFrozen/);
    expect(viewSource).toMatch(/func redo\(\)[\s\S]*guard !isFrozen/);
    expect(viewSource).toMatch(/func clear\(\)[\s\S]*guard !isFrozen/);
    expect(viewSource).toMatch(/func clearSelection\(\)[\s\S]*guard !isFrozen/);
    expect(viewSource).toMatch(/handleSelectionPan[\s\S]*guard !isFrozen/);
    expect(viewSource).toMatch(
      /canvasViewDrawingDidChange[\s\S]*guard !isFrozen else[\s\S]*restoreFrozenDrawing\(\)/,
    );
    expect(viewSource).toMatch(
      /setFrozen[\s\S]*canvasView\.isUserInteractionEnabled[\s\S]*selectionOverlay\.isUserInteractionEnabled/,
    );
    expect(viewSource).toMatch(/updateToolPickerVisibility[\s\S]*!isFrozen/);
  });
});
