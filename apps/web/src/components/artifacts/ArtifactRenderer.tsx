import type { ChatArtifactAttachment } from "@t3tools/contracts";
import { lazy, Suspense } from "react";

import { lightfastWebCapabilities } from "~/lightfast/register";

type ArtifactRendererProps = {
  readonly artifact: ChatArtifactAttachment;
};

const artifactRenderers = new Map(
  [...lightfastWebCapabilities.artifactRenderers].map(([key, registration]) => [
    key,
    lazy(registration.load),
  ]),
);

export function hasArtifactRenderer(kind: string): boolean {
  return [...lightfastWebCapabilities.artifactRenderers.values()].some(
    (registration) => registration.kind === kind,
  );
}

function UnsupportedArtifact({ artifact }: ArtifactRendererProps) {
  return (
    <div className="my-3 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
      Unsupported artifact · {artifact.kind} v{artifact.schemaVersion}
    </div>
  );
}

export function ArtifactRenderer({ artifact }: ArtifactRendererProps) {
  const Renderer = artifactRenderers.get(
    lightfastWebCapabilities.artifactRendererKey(artifact.kind, artifact.schemaVersion),
  );
  if (Renderer === undefined) return <UnsupportedArtifact artifact={artifact} />;

  return (
    <Suspense
      fallback={
        <div className="my-3 flex aspect-[16/9] min-h-64 items-center justify-center rounded-xl border border-border bg-card text-sm text-muted-foreground">
          Loading interactive scene…
        </div>
      }
    >
      <Renderer artifact={artifact} />
    </Suspense>
  );
}
