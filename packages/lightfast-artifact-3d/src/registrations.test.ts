import { describe, expect, it } from "vite-plus/test";

import { scene3DArtifactDefinition } from "./contracts.ts";
import { scene3DMobileCapability } from "./mobile.ts";
import { scene3DWebCapability } from "./web.tsx";

describe("3D environment registrations", () => {
  it("owns its web renderer descriptor and keeps loading deferred", () => {
    expect(scene3DWebCapability.artifactDefinition).toBe(scene3DArtifactDefinition);
    expect(scene3DWebCapability.loadRenderer).toBeTypeOf("function");
  });

  it("owns its mobile fallback presentation", () => {
    expect(scene3DMobileCapability.artifactDefinition).toBe(scene3DArtifactDefinition);
    expect(scene3DMobileCapability.presentation.description).toBe(
      "Interactive 3D scene · open on Mac or web to rotate and explore",
    );
  });
});
