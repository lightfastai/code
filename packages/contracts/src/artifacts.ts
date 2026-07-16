import { ArtifactEnvelope } from "@t3tools/lightfast-capability-core/artifacts";
import { ChatScene3DArtifact } from "@t3tools/lightfast-artifact-3d/contracts";
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

export * from "@t3tools/lightfast-capability-core/artifacts";
export * from "@t3tools/lightfast-artifact-3d/contracts";

export const ChatArtifactAttachment = ArtifactEnvelope;
export type ChatArtifactAttachment = typeof ChatArtifactAttachment.Type;

export const StudyLiveSceneTopic = "t3.study.scene.v1" as const;

export const StudyLiveSceneMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("study.scene.replace"),
    version: Schema.Literal(1),
    sequence: NonNegativeInt,
    artifact: ChatScene3DArtifact,
  }),
  Schema.Struct({
    type: Schema.Literal("study.scene.clear"),
    version: Schema.Literal(1),
    sequence: NonNegativeInt,
  }),
]);
export type StudyLiveSceneMessage = typeof StudyLiveSceneMessage.Type;
