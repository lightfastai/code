import {
  ArtifactPublishError,
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  NotebookAgentToolError,
  StudyToolError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "artifacts" | "study";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly allowNotebookExecution: boolean;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

export const requireArtifactCapability = Effect.fn("mcp.requireArtifactCapability")(function* () {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has("artifacts")) {
    return yield* new ArtifactPublishError({
      message: "MCP credential does not grant the artifacts capability.",
    });
  }
  return invocation;
});

export const requireStudyCapability = Effect.fn("mcp.requireStudyCapability")(function* () {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has("study")) {
    return yield* new StudyToolError({
      message: "MCP credential does not grant the study capability.",
    });
  }
  return invocation;
});

export const requireNotebookExecution = Effect.fn("mcp.requireNotebookExecution")(function* () {
  const invocation = yield* McpInvocationContext;
  if (!invocation.allowNotebookExecution) {
    return yield* new NotebookAgentToolError({
      reason: "permission-denied",
      message: "This thread does not grant notebook execution to the agent.",
    });
  }
  return invocation;
});
