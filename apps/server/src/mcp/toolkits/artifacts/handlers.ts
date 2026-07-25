import * as NodeCrypto from "node:crypto";

import {
  ArtifactPublishError,
  CommandId,
  MessageId,
  type PublishScene3DArtifactInput,
  type PublishScene3DArtifactResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";

import { lightfastServerCapabilities } from "../../../lightfast/register.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ArtifactToolkit } from "./tools.ts";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "The 3D artifact could not be published.";

const publishScene = (input: PublishScene3DArtifactInput) =>
  Effect.gen(function* () {
    const invocation = yield* McpInvocationContext.requireArtifactCapability();
    const orchestration = yield* OrchestrationEngineService;
    const id = NodeCrypto.randomUUID();
    const artifactId = `artifact-${id}`;
    const messageId = `artifact-message-${id}`;
    const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const artifact = yield* lightfastServerCapabilities.artifactRegistry.decodeForPublication(
      lightfastServerCapabilities.scene3D.makeArtifact(artifactId, input),
    );

    yield* orchestration.dispatch({
      type: "thread.message.artifact.publish",
      commandId: CommandId.make(`artifact-command-${id}`),
      threadId: invocation.threadId,
      messageId: MessageId.make(messageId),
      artifact: artifact.artifact,
      createdAt,
    });

    return {
      artifactId,
      messageId,
    } satisfies PublishScene3DArtifactResult;
  }).pipe(Effect.mapError((cause) => new ArtifactPublishError({ message: errorMessage(cause) })));

export const ArtifactToolkitHandlersLive = ArtifactToolkit.toLayer({
  artifact_publish_3d_scene: publishScene,
});
