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
