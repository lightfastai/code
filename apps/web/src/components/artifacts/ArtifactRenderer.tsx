import type { ChatArtifactAttachment } from "@t3tools/contracts";
import { lazy, Suspense, type ComponentType } from "react";

const Scene3DArtifact = lazy(() =>
  import("./Scene3DArtifact").then((module) => ({ default: module.Scene3DArtifact })),
);

type ArtifactRendererProps = {
  readonly artifact: ChatArtifactAttachment;
};

const artifactRendererRegistry: Readonly<
  Record<ChatArtifactAttachment["kind"], ComponentType<ArtifactRendererProps>>
> = {
  "3d-scene": Scene3DArtifact,
};

export function hasArtifactRenderer(kind: string): kind is ChatArtifactAttachment["kind"] {
  return Object.hasOwn(artifactRendererRegistry, kind);
}

export function ArtifactRenderer({ artifact }: ArtifactRendererProps) {
  const Renderer = artifactRendererRegistry[artifact.kind];
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
