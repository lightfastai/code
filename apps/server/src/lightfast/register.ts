import { ArtifactRegistry } from "@t3tools/lightfast-capability-core/registry";
import { scene3DServerCapability } from "@t3tools/lightfast-artifact-3d/server";
import { notebookServerCapability } from "@t3tools/lightfast-artifact-notebook/server";

export const lightfastServerCapabilities = {
  artifactRegistry: ArtifactRegistry.make([
    scene3DServerCapability.artifactDefinition,
    notebookServerCapability.artifactDefinition,
  ]),
  scene3D: scene3DServerCapability,
  notebook: notebookServerCapability,
} as const;
