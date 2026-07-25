import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-artifacts");
const turnId = TurnId.make("turn-artifacts");

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [],
  threads: [
    {
      id: threadId,
      projectId: ProjectId.make("project-artifacts"),
      title: "Artifacts",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: "default",
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      latestTurn: {
        turnId,
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
};

it.layer(NodeServices.layer)("artifact publishing decider", (it) => {
  it.effect("publishes a semantic artifact as an assistant message on the active turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.message.artifact.publish",
          commandId: CommandId.make("command-publish-artifact"),
          threadId,
          messageId: MessageId.make("message-artifact"),
          artifact: {
            type: "artifact",
            id: "artifact-vector",
            kind: "3d-scene",
            schemaVersion: 1,
            title: "A vector in space",
            capabilities: ["orbit", "zoom"],
            payload: {
              objects: [
                {
                  type: "vector",
                  id: "vector-a",
                  start: [0, 0, 0],
                  end: [2, 1, 0],
                  label: "a",
                },
              ],
            },
          },
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.message-sent");
      if (event.type !== "thread.message-sent") return;
      expect(event.payload.role).toBe("assistant");
      expect(event.payload.turnId).toBe(turnId);
      expect(event.payload.attachments?.[0]).toMatchObject({
        type: "artifact",
        kind: "3d-scene",
        id: "artifact-vector",
      });
    }),
  );
});
