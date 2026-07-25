import { scene3DArtifactDefinition } from "./contracts.ts";

export const scene3DMobileCapability = {
  artifactDefinition: scene3DArtifactDefinition,
  presentation: {
    description: "Interactive 3D scene · open on Mac or web to rotate and explore",
  },
} as const;
