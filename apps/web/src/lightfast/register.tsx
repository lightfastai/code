import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import { ArtifactRegistry } from "@t3tools/lightfast-capability-core/registry";
import { scene3DArtifactDefinition } from "@t3tools/lightfast-artifact-3d/contracts";
import type { ComponentType } from "react";

export type LightfastArtifactRenderer = ComponentType<{
  readonly artifact: ArtifactEnvelope;
}>;

export type LightfastArtifactRendererRegistration = {
  readonly kind: string;
  readonly schemaVersion: number;
  readonly load: () => Promise<{ readonly default: LightfastArtifactRenderer }>;
};

const artifactRendererKey = (kind: string, schemaVersion: number) => `${kind}@${schemaVersion}`;

const scene3DRenderer: LightfastArtifactRendererRegistration = {
  kind: scene3DArtifactDefinition.kind,
  schemaVersion: scene3DArtifactDefinition.schemaVersion,
  load: () =>
    import("@t3tools/lightfast-artifact-3d/web").then((module) => ({
      default: module.Scene3DArtifactEnvelopeRenderer,
    })),
};

export const lightfastWebCapabilities = {
  artifactRegistry: ArtifactRegistry.make([scene3DArtifactDefinition]),
  artifactRenderers: new Map([
    [artifactRendererKey(scene3DRenderer.kind, scene3DRenderer.schemaVersion), scene3DRenderer],
  ]),
  artifactRendererKey,
} as const;
