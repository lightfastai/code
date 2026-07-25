import {
  ArtifactPublishError,
  PublishScene3DArtifactInput,
  PublishScene3DArtifactResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

export const PublishScene3DArtifactTool = Tool.make("artifact_publish_3d_scene", {
  description:
    "Publish a validated, interactive 3D scene directly into this conversation. Use semantic points, vectors, segments, spheres, circles, and planes; never emit JavaScript. Prefer this when rotating or inspecting a spatial explanation would help the user understand it.",
  parameters: PublishScene3DArtifactInput,
  success: PublishScene3DArtifactResult,
  failure: ArtifactPublishError,
  dependencies: [McpInvocationContext.McpInvocationContext, OrchestrationEngineService],
})
  .annotate(Tool.Title, "Publish interactive 3D scene")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ArtifactToolkit = Toolkit.make(PublishScene3DArtifactTool);
