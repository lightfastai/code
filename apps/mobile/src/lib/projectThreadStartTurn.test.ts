import { describe, expect, it } from "vite-plus/test";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";

import { buildProjectThreadStartTurnInput } from "./projectThreadStartTurn";

describe("buildProjectThreadStartTurnInput", () => {
  it("propagates the normalized selected study document authority", () => {
    const documentIds = ["a".repeat(64), "b".repeat(64)];
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project-1"),
      projectCwd: "/tmp/project-1",
      threadId: "thread-1",
      commandId: "command-1",
      messageId: "message-1",
      createdAt: "2026-07-17T00:00:00.000Z",
      text: "Compare the selected books",
      attachments: [],
      documentIds,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceMode: "local",
      branch: "main",
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "feat/unused",
    });

    expect(input.documentIds).toEqual(documentIds);
  });
});
