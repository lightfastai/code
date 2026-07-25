import { describe, expect, it } from "vite-plus/test";

import {
  describeMobileArtifact,
  lightfastMobileCapabilities,
  resolveMobileArtifactNativeRenderer,
} from "./register";

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

  it("registers the namespaced notebook capability with a native presentation", () => {
    const artifact = {
      type: "artifact" as const,
      id: "artifact-notebook",
      kind: "notebook",
      schemaVersion: 1,
      title: "Analysis",
      payload: {
        documentId: "notebook-1",
        revisionId: "a".repeat(64),
        contentHash: "b".repeat(64),
        kernel: { name: "python3", displayName: "Python 3", language: "python" },
        initialView: { mode: "notebook" as const },
      },
    };

    expect(lightfastMobileCapabilities.productCapabilities).toContain("lightfast.notebook");
    expect(lightfastMobileCapabilities.artifactRegistry.definitions.has("notebook")).toBe(true);
    expect(describeMobileArtifact(artifact)).toBe(
      "Interactive notebook · run securely on your paired Mac",
    );
    expect(resolveMobileArtifactNativeRenderer(artifact)).toBe("lightfast.notebook");
  });
});
