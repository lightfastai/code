import { expect, it } from "@effect/vitest";
import {
  ArtifactPublishError,
  EnvironmentId,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  StudyToolError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    allowNotebookExecution: false,
    issuedAt: 1,
    expiresAt: 2,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the preview capability.");
  });
});

it.effect("rejects artifact publication without the scoped capability", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["study"]),
    allowNotebookExecution: false,
    issuedAt: 1,
    expiresAt: 2,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireArtifactCapability().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(ArtifactPublishError);
    expect(error.message).toBe("MCP credential does not grant the artifacts capability.");
  });
});

it.effect("rejects study access without the scoped capability", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["artifacts"]),
    allowNotebookExecution: false,
    issuedAt: 1,
    expiresAt: 2,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireStudyCapability().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(StudyToolError);
    expect(error.message).toBe("MCP credential does not grant the study capability.");
  });
});

it.effect("requires the explicit thread-scoped notebook execution grant", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["artifacts"]),
    allowNotebookExecution: false,
    issuedAt: 1,
    expiresAt: 2,
  };

  return Effect.gen(function* () {
    const denied = yield* McpInvocationContext.requireNotebookExecution().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(denied).toMatchObject({
      _tag: "NotebookAgentToolError",
      reason: "permission-denied",
    });

    const allowed = yield* McpInvocationContext.requireNotebookExecution().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        allowNotebookExecution: true,
      }),
    );
    expect(allowed.threadId).toBe(invocation.threadId);
  });
});
