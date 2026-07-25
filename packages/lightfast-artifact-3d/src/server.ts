import {
  scene3DArtifactDefinition,
  scene3DDefaultCapabilities,
  type ChatScene3DArtifact,
  type PublishScene3DArtifactInput,
} from "./contracts.ts";

export const makeScene3DArtifact = (
  id: string,
  input: PublishScene3DArtifactInput,
): ChatScene3DArtifact => ({
  type: "artifact",
  id,
  kind: scene3DArtifactDefinition.kind,
  schemaVersion: scene3DArtifactDefinition.schemaVersion,
  title: input.title,
  payload: input.payload,
  ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  capabilities: input.capabilities ?? scene3DDefaultCapabilities,
});

export const scene3DServerCapability = {
  artifactDefinition: scene3DArtifactDefinition,
  makeArtifact: makeScene3DArtifact,
} as const;
