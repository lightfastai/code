import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import {
  artifactRegistrationKey,
  ArtifactRegistry,
  type ArtifactDefinition,
} from "@t3tools/lightfast-capability-core/registry";
import { scene3DWebCapability } from "@t3tools/lightfast-artifact-3d/web";
import { notebookWebCapability } from "@t3tools/lightfast-artifact-notebook/web";
import type { ComponentType } from "react";

export type LightfastArtifactRenderer = ComponentType<{
  readonly artifact: ArtifactEnvelope;
}>;

export type LightfastArtifactRendererRegistration = {
  readonly artifactDefinition: ArtifactDefinition<string, unknown>;
  readonly loadRenderer: () => Promise<{ readonly default: LightfastArtifactRenderer }>;
};

const webArtifactCapabilities: readonly LightfastArtifactRendererRegistration[] = [
  scene3DWebCapability,
  notebookWebCapability,
];

export const lightfastWebCapabilities = {
  artifactRegistry: ArtifactRegistry.make(
    webArtifactCapabilities.map((capability) => capability.artifactDefinition),
  ),
  artifactRenderers: new Map(
    webArtifactCapabilities.map((capability) => [
      artifactRegistrationKey(capability.artifactDefinition),
      capability,
    ]),
  ),
} as const;
