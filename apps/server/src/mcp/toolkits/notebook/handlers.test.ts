import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import type { NotebookRevision } from "@t3tools/lightfast-artifact-notebook/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { NotebookRevisionStore } from "../../../notebook/NotebookRevisionStore.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { publishNotebook } from "./handlers.ts";

const environmentId = EnvironmentId.make("environment-publish-notebook");
const projectId = ProjectId.make("project-publish-notebook");
const threadId = ThreadId.make("thread-publish-notebook");
const revision = {
  documentId: "published-notebook",
  revisionId: "a".repeat(64),
  contentHash: "a".repeat(64),
  kernel: { name: "python3", displayName: "Python 3", language: "python" },
  document: {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      lightfast: { title: "Published notebook" },
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
    },
    cells: [],
  },
  createdAt: "2026-07-17T00:00:00.000Z",
} as NotebookRevision;

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-publish-notebook",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["artifacts"]),
  allowNotebookExecution: false,
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

it.effect("publishes an exact immutable notebook revision without the execution grant", () => {
  const dispatched: OrchestrationCommand[] = [];
  const projection = ProjectionSnapshotQuery.of({
    getThreadShellById: () => Effect.succeed(Option.some({ projectId } as never)),
  } as unknown as ProjectionSnapshotQuery["Service"]);
  const store = NotebookRevisionStore.of({
    read: () => Effect.succeed(revision),
    save: () => Effect.die("unused"),
    importIpynb: () => Effect.die("unused"),
    exportIpynb: () => Effect.die("unused"),
  });
  const orchestration = OrchestrationEngineService.of({
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: 1 };
      }),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
  });

  return Effect.gen(function* () {
    const result = yield* publishNotebook({
      scope: { environmentId, projectId },
      documentId: revision.documentId,
      revisionId: revision.revisionId,
      initialView: { mode: "notebook" },
    });

    expect(result.artifactId).toMatch(/^artifact-/);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.message.artifact.publish",
      threadId,
      artifact: {
        kind: "notebook",
        payload: {
          documentId: revision.documentId,
          revisionId: revision.revisionId,
          contentHash: revision.contentHash,
        },
      },
    });
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(ProjectionSnapshotQuery, projection),
    Effect.provideService(NotebookRevisionStore, store),
    Effect.provideService(OrchestrationEngineService, orchestration),
  );
});
