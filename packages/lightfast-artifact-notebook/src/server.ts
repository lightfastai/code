import type { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";

import { notebookArtifactDefinition, type NotebookArtifactPayload } from "./contracts.ts";

export const makeNotebookArtifact = (input: {
  readonly id: string;
  readonly title: string;
  readonly payload: NotebookArtifactPayload;
}): ArtifactEnvelope => {
  const initialView: Record<string, string> = { mode: input.payload.initialView.mode };
  if (input.payload.initialView.cellId !== undefined) {
    initialView.cellId = input.payload.initialView.cellId;
  }
  return {
    type: "artifact",
    id: input.id,
    kind: notebookArtifactDefinition.kind,
    schemaVersion: notebookArtifactDefinition.schemaVersion,
    title: input.title,
    payload: {
      documentId: input.payload.documentId,
      revisionId: input.payload.revisionId,
      contentHash: input.payload.contentHash,
      kernel: input.payload.kernel,
      initialView,
    },
    capabilities: [...notebookArtifactDefinition.capabilities],
  };
};

export const notebookServerCapability = {
  artifactDefinition: notebookArtifactDefinition,
  makeArtifact: makeNotebookArtifact,
} as const;
