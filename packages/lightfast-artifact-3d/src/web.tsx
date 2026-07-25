import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import { lazy, Suspense, type ComponentType } from "react";

import { scene3DArtifactDefinition, type ChatScene3DArtifact } from "./contracts.ts";

type ArtifactRenderer = ComponentType<{ readonly artifact: ArtifactEnvelope }>;

const loadWebRenderer = () => import("./web-renderer.tsx");

const loadScene3DEnvelopeRenderer = (): Promise<{ readonly default: ArtifactRenderer }> =>
  loadWebRenderer().then((module) => ({
    default: module.Scene3DArtifactEnvelopeRenderer,
  }));

const LazyScene3DArtifact = lazy(() =>
  loadWebRenderer().then((module) => ({
    default: module.Scene3DArtifact as ComponentType<{
      readonly artifact: ChatScene3DArtifact;
    }>,
  })),
);

export function Scene3DArtifact({ artifact }: { readonly artifact: ChatScene3DArtifact }) {
  return (
    <Suspense
      fallback={
        <div className="my-3 flex aspect-[16/9] min-h-64 items-center justify-center rounded-xl border border-border bg-card text-sm text-muted-foreground">
          Loading interactive scene…
        </div>
      }
    >
      <LazyScene3DArtifact artifact={artifact} />
    </Suspense>
  );
}

export const scene3DWebCapability = {
  artifactDefinition: scene3DArtifactDefinition,
  loadRenderer: loadScene3DEnvelopeRenderer,
} as const;
