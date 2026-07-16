import { afterEach, describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, type StudyDocument } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import {
  clearComposerDraftContentState,
  composerDraftsAtom,
  decodePersistedComposerDrafts,
  type ComposerDraft,
  getComposerDraftSnapshot,
  removeComposerDraftsForEnvironment,
} from "./use-composer-drafts";

const DRAFT: ComposerDraft = {
  text: "hello",
  attachments: [],
};

const STUDY_DOCUMENT: StudyDocument = {
  id: "a".repeat(64),
  sha256: "a".repeat(64),
  format: "pdf",
  title: "Linear Algebra Done Right",
  fileName: "linear-algebra.pdf",
  objectKey: `objects/aa/${"a".repeat(64)}.pdf`,
  sizeBytes: 123,
  tags: ["math"],
  importedAt: "2026-07-15T00:00:00.000Z",
};

afterEach(() => {
  appAtomRegistry.set(composerDraftsAtom, {});
});

describe("mobile composer drafts", () => {
  it("hydrates selector state even when the message content is empty", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "new-task:environment-1:project-1": {
            text: "",
            attachments: [],
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "xhigh" }],
            },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            workspaceSelection: {
              mode: "worktree",
              branch: "main",
              worktreePath: null,
            },
          },
        },
      }),
    ).toEqual({
      "new-task:environment-1:project-1": {
        text: "",
        attachments: [],
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        workspaceSelection: {
          mode: "worktree",
          branch: "main",
          worktreePath: null,
        },
      },
    });
  });

  it("hydrates pinned study documents even when message content is empty", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": {
            text: "",
            attachments: [],
            studyDocuments: [STUDY_DOCUMENT],
          },
        },
      }),
    ).toEqual({
      "environment-1:thread-1": {
        text: "",
        attachments: [],
        studyDocuments: [STUDY_DOCUMENT],
      },
    });
  });

  it("keeps legacy content-only drafts and rejects invalid selector state", () => {
    expect(
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": DRAFT,
        },
      }),
    ).toEqual({
      "environment-1:thread-1": DRAFT,
    });

    expect(() =>
      decodePersistedComposerDrafts({
        schemaVersion: 1,
        drafts: {
          "environment-1:thread-1": {
            ...DRAFT,
            runtimeMode: "sometimes-safe",
          },
        },
      }),
    ).toThrow();
  });

  it("clears sent content without clearing model, workspace, or pinned books", () => {
    const draftKey = "environment-1:thread-1";
    const draft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      workspaceSelection: {
        mode: "worktree",
        branch: "main",
        worktreePath: null,
      },
      studyDocuments: [STUDY_DOCUMENT],
    };

    expect(clearComposerDraftContentState({ [draftKey]: draft }, draftKey)).toEqual({
      [draftKey]: {
        ...draft,
        text: "",
        attachments: [],
      },
    });
  });

  it("rejects malformed or excessive pinned study documents", () => {
    const persistedDraft = (studyDocuments: ReadonlyArray<unknown>) => ({
      schemaVersion: 1,
      drafts: {
        "environment-1:thread-1": {
          ...DRAFT,
          studyDocuments,
        },
      },
    });

    expect(() =>
      decodePersistedComposerDrafts(persistedDraft([{ ...STUDY_DOCUMENT, id: "not-a-sha256" }])),
    ).toThrow();
    expect(() =>
      decodePersistedComposerDrafts(
        persistedDraft(
          Array.from({ length: 33 }, (_, index) => ({
            ...STUDY_DOCUMENT,
            id: index.toString(16).padStart(64, "0"),
            sha256: index.toString(16).padStart(64, "0"),
          })),
        ),
      ),
    ).toThrow();
  });

  it("reads the latest selector state synchronously for send", () => {
    const draftKey = "environment-1:thread-1";
    const selectedDraft: ComposerDraft = {
      text: "send this",
      attachments: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    };
    appAtomRegistry.set(composerDraftsAtom, { [draftKey]: selectedDraft });

    expect(getComposerDraftSnapshot(draftKey)).toEqual(selectedDraft);
  });

  it("removes only drafts owned by the selected environment", () => {
    const environmentId = EnvironmentId.make("environment-cloud");
    const retainedEnvironmentId = EnvironmentId.make("environment-local");

    expect(
      removeComposerDraftsForEnvironment(
        {
          [`${environmentId}:thread-cloud`]: DRAFT,
          [`new-task:${environmentId}:project-cloud`]: DRAFT,
          [`${retainedEnvironmentId}:thread-local`]: DRAFT,
          [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
        },
        environmentId,
      ),
    ).toEqual({
      [`${retainedEnvironmentId}:thread-local`]: DRAFT,
      [`new-task:${retainedEnvironmentId}:project-local`]: DRAFT,
    });
  });
});
