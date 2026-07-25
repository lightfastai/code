import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import {
  artifactRegistrationKey,
  ArtifactRegistry,
} from "@t3tools/lightfast-capability-core/registry";
import { scene3DMobileCapability } from "@t3tools/lightfast-artifact-3d/mobile";
import { notebookMobileCapability } from "@t3tools/lightfast-artifact-notebook/mobile";

type MobileArtifactPresentation = {
  readonly description: string;
};

const mobileArtifactCapabilities = [scene3DMobileCapability, notebookMobileCapability] as const;
const mobileNativeRendererCapabilities = [notebookMobileCapability] as const;

export const lightfastMobileCapabilities = {
  productCapabilities: mobileArtifactCapabilities.flatMap((capability) =>
    "name" in capability ? [capability.name] : [],
  ),
  artifactRegistry: ArtifactRegistry.make(
    mobileArtifactCapabilities.map((capability) => capability.artifactDefinition),
  ),
  artifactPresentations: new Map<string, MobileArtifactPresentation>(
    mobileArtifactCapabilities.map((capability) => [
      artifactRegistrationKey(capability.artifactDefinition),
      capability.presentation,
    ]),
  ),
  nativeRenderers: new Map<string, string>(
    mobileNativeRendererCapabilities.map((capability) => [
      artifactRegistrationKey(capability.artifactDefinition),
      capability.name,
    ]),
  ),
} as const;

export const describeMobileArtifact = (artifact: ArtifactEnvelope): string =>
  lightfastMobileCapabilities.artifactPresentations.get(artifactRegistrationKey(artifact))
    ?.description ?? `Unsupported artifact · ${artifact.kind} v${artifact.schemaVersion}`;

export const resolveMobileArtifactNativeRenderer = (artifact: ArtifactEnvelope): string | null =>
  lightfastMobileCapabilities.nativeRenderers.get(artifactRegistrationKey(artifact)) ?? null;
