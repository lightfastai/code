import { describe, expect, it } from "vite-plus/test";

import { describeMobileArtifact } from "./register";

describe("mobile artifact capability fallback", () => {
  it("preserves the 3D handoff presentation", () => {
    expect(
      describeMobileArtifact({
        type: "artifact",
        id: "artifact-scene",
        kind: "3d-scene",
        schemaVersion: 1,
        title: "Scene",
        payload: { objects: [] },
      }),
    ).toBe("Interactive 3D scene · open on Mac or web to rotate and explore");
  });

  it("describes unknown artifacts without crashing", () => {
    expect(
      describeMobileArtifact({
        type: "artifact",
        id: "artifact-future",
        kind: "vendor.future",
        schemaVersion: 7,
        title: "Future",
        payload: { opaque: true },
      }),
    ).toBe("Unsupported artifact · vendor.future v7");
  });
});
