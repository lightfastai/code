import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import { ArtifactRegistry } from "@t3tools/lightfast-capability-core/registry";
import { scene3DArtifactDefinition } from "@t3tools/lightfast-artifact-3d/contracts";

type MobileArtifactPresentation = {
  readonly description: string;
};

const artifactPresentationKey = (kind: string, schemaVersion: number) => `${kind}@${schemaVersion}`;

export const lightfastMobileCapabilities = {
  artifactRegistry: ArtifactRegistry.make([scene3DArtifactDefinition]),
  artifactPresentations: new Map<string, MobileArtifactPresentation>([
    [
      artifactPresentationKey(
        scene3DArtifactDefinition.kind,
        scene3DArtifactDefinition.schemaVersion,
      ),
      { description: "Interactive 3D scene · open on Mac or web to rotate and explore" },
    ],
  ]),
  artifactPresentationKey,
} as const;

export const describeMobileArtifact = (artifact: ArtifactEnvelope): string =>
  lightfastMobileCapabilities.artifactPresentations.get(
    artifactPresentationKey(artifact.kind, artifact.schemaVersion),
  )?.description ?? `Unsupported artifact · ${artifact.kind} v${artifact.schemaVersion}`;
