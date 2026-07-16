import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import {
  artifactRegistrationKey,
  ArtifactRegistry,
} from "@t3tools/lightfast-capability-core/registry";
import { scene3DMobileCapability } from "@t3tools/lightfast-artifact-3d/mobile";

type MobileArtifactPresentation = {
  readonly description: string;
};

const mobileArtifactCapabilities = [scene3DMobileCapability] as const;

export const lightfastMobileCapabilities = {
  artifactRegistry: ArtifactRegistry.make(
    mobileArtifactCapabilities.map((capability) => capability.artifactDefinition),
  ),
  artifactPresentations: new Map<string, MobileArtifactPresentation>(
    mobileArtifactCapabilities.map((capability) => [
      artifactRegistrationKey(capability.artifactDefinition),
      capability.presentation,
    ]),
  ),
} as const;

export const describeMobileArtifact = (artifact: ArtifactEnvelope): string =>
  lightfastMobileCapabilities.artifactPresentations.get(artifactRegistrationKey(artifact))
    ?.description ?? `Unsupported artifact · ${artifact.kind} v${artifact.schemaVersion}`;
