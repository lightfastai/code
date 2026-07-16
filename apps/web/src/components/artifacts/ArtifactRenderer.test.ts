import { describe, expect, it } from "vite-plus/test";

import { hasArtifactRenderer } from "./ArtifactRenderer.tsx";

describe("artifact renderer registry", () => {
  it("registers the versioned 3D scene renderer", () => {
    expect(hasArtifactRenderer("3d-scene")).toBe(true);
  });

  it("does not claim unknown artifact kinds", () => {
    expect(hasArtifactRenderer("javascript-widget")).toBe(false);
  });
});
