// @effect-diagnostics nodeBuiltinImport:off
/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- This integration harness explicitly owns and disposes a ManagedRuntime across imperative provider-event assertions. */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ModelSelection,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@t3tools/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProviderRuntimeIngestionService
    | ProjectionSnapshotQuery
    | ProjectionTurnRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    vi.restoreAllMocks();
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly sessionModelSwitch?: "unsupported" | "in-session";
    readonly requiresNewThreadForModelChange?: boolean;
    readonly initialNotebookDocumentIds?: ReadonlyArray<string>;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir =
      input?.baseDir ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const lifecycleCalls: string[] = [];
    let nextSessionIndex = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSession = vi.fn((_: unknown, input: unknown) => {
      lifecycleCalls.push("start-session");
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" || input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      runtimeSessions.push(session);
      return Effect.succeed(session);
    });
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((_) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const providerSnapshots = [
      {
        instanceId: modelSelection.instanceId,
        ...(input?.requiresNewThreadForModelChange === true
          ? { requiresNewThreadForModelChange: true }
          : {}),
      },
    ];
    let notebookDocumentIds = Array.from(new Set(input?.initialNotebookDocumentIds ?? [])).sort();
    let stagedNotebookAuthority:
      | {
          readonly messageId: MessageId;
          readonly previousDocumentIds: ReadonlyArray<string>;
          readonly documentIds: ReadonlyArray<string>;
          providerSendCompleted: boolean;
          runtimeAdmitted: boolean;
        }
      | undefined;
    const authorityExposures: Array<ReadonlyArray<string>> = [[...notebookDocumentIds]];
    const exposeNotebookAuthority = (documentIds: ReadonlyArray<string>) => {
      notebookDocumentIds = [...documentIds];
      authorityExposures.push([...documentIds]);
    };
    const setNotebookDocumentAuthority = vi.fn(
      (authority: { readonly documentIds: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          const normalized = Array.from(new Set(authority.documentIds)).sort();
          lifecycleCalls.push(`authority:${normalized.join(",")}`);
          stagedNotebookAuthority = undefined;
          exposeNotebookAuthority(normalized);
          return normalized;
        }),
    );
    const stageNotebookDocumentAuthorityTurn = vi.fn(
      (authority: { readonly messageId: MessageId; readonly documentIds: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          const normalized = Array.from(new Set(authority.documentIds)).sort();
          if (stagedNotebookAuthority !== undefined) {
            return stagedNotebookAuthority.messageId === authority.messageId;
          }
          lifecycleCalls.push(`authority-stage:${normalized.join(",")}`);
          stagedNotebookAuthority = {
            messageId: authority.messageId,
            previousDocumentIds: [...notebookDocumentIds],
            documentIds: normalized,
            providerSendCompleted: false,
            runtimeAdmitted: false,
          };
          return true;
        }),
    );
    const completeNotebookDocumentAuthorityTurn = vi.fn(
      (authority: { readonly threadId: ThreadId; readonly messageId: MessageId }) =>
        Effect.sync(() => {
          if (stagedNotebookAuthority?.messageId !== authority.messageId) {
            return false;
          }
          stagedNotebookAuthority.providerSendCompleted = true;
          lifecycleCalls.push(
            `authority-complete:${stagedNotebookAuthority.documentIds.join(",")}`,
          );
          return true;
        }),
    );
    const admitNotebookDocumentAuthorityTurn = vi.fn(
      (authority: { readonly threadId: ThreadId; readonly messageId: MessageId }) =>
        Effect.sync(() => {
          if (stagedNotebookAuthority?.messageId !== authority.messageId) {
            return false;
          }
          if (!stagedNotebookAuthority.runtimeAdmitted) {
            exposeNotebookAuthority(stagedNotebookAuthority.documentIds);
            stagedNotebookAuthority.runtimeAdmitted = true;
          }
          lifecycleCalls.push(`authority-admit:${stagedNotebookAuthority.documentIds.join(",")}`);
          return true;
        }),
    );
    const finalizeNotebookDocumentAuthorityTurn = vi.fn(
      (authority: { readonly threadId: ThreadId; readonly messageId: MessageId }) =>
        Effect.sync(() => {
          if (
            stagedNotebookAuthority?.messageId !== authority.messageId ||
            !stagedNotebookAuthority.providerSendCompleted ||
            !stagedNotebookAuthority.runtimeAdmitted
          ) {
            return false;
          }
          lifecycleCalls.push(
            `authority-finalize:${stagedNotebookAuthority.documentIds.join(",")}`,
          );
          stagedNotebookAuthority = undefined;
          return true;
        }),
    );
    const rollbackNotebookDocumentAuthorityTurn = vi.fn(
      (authority: { readonly threadId: ThreadId; readonly messageId: MessageId }) =>
        Effect.sync(() => {
          if (stagedNotebookAuthority?.messageId !== authority.messageId) {
            return false;
          }
          if (stagedNotebookAuthority.runtimeAdmitted) {
            exposeNotebookAuthority(stagedNotebookAuthority.previousDocumentIds);
          }
          lifecycleCalls.push(
            `authority-rollback:${stagedNotebookAuthority.documentIds.join(",")}`,
          );
          stagedNotebookAuthority = undefined;
          return true;
        }),
    );
    vi.spyOn(McpSessionRegistry, "setActiveNotebookDocumentAuthority").mockImplementation(
      setNotebookDocumentAuthority,
    );
    vi.spyOn(McpSessionRegistry, "stageActiveNotebookDocumentAuthorityTurn").mockImplementation(
      stageNotebookDocumentAuthorityTurn,
    );
    vi.spyOn(McpSessionRegistry, "completeActiveNotebookDocumentAuthorityTurn").mockImplementation(
      completeNotebookDocumentAuthorityTurn,
    );
    vi.spyOn(McpSessionRegistry, "admitActiveNotebookDocumentAuthorityTurn").mockImplementation(
      admitNotebookDocumentAuthorityTurn,
    );
    vi.spyOn(McpSessionRegistry, "finalizeActiveNotebookDocumentAuthorityTurn").mockImplementation(
      finalizeNotebookDocumentAuthorityTurn,
    );
    vi.spyOn(McpSessionRegistry, "rollbackActiveNotebookDocumentAuthorityTurn").mockImplementation(
      rollbackNotebookDocumentAuthorityTurn,
    );

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const listSessions = vi.fn(() => Effect.succeed(runtimeSessions));
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      listSessions,
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
        }),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(ProviderCommandReactorLive),
      Layer.provideMerge(ProjectionTurnRepositoryLive),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(makeProviderRegistryLayer(providerSnapshots as never)),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    const turns = await runtime.runPromise(Effect.service(ProjectionTurnRepository));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);
    const drainIngestion = () => Effect.runPromise(ingestion.drain);
    let completedAdmissionCount = 0;
    const completeAcceptedTurn = (tag: string) =>
      Effect.gen(function* () {
        completedAdmissionCount += 1;
        const threadId = ThreadId.make("thread-1");
        const acceptedTurnStart = yield* turns.getAcceptedTurnStartByThreadId({ threadId });
        const acceptedMessageId = Option.isSome(acceptedTurnStart)
          ? acceptedTurnStart.value.messageId
          : null;
        if (acceptedMessageId !== null) {
          yield* completeNotebookDocumentAuthorityTurn({
            threadId,
            messageId: acceptedMessageId,
          });
          yield* turns.completeAcceptedTurnStartPhase({
            threadId,
            messageId: acceptedMessageId,
            phase: "provider-send-completed",
          });
          yield* admitNotebookDocumentAuthorityTurn({
            threadId,
            messageId: acceptedMessageId,
          });
        }
        const turnId = asTurnId(`turn-completed-admission-${tag}-${completedAdmissionCount}`);
        const completedAt = `2026-01-01T00:00:${String(completedAdmissionCount).padStart(2, "0")}.000Z`;
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-session-running-${tag}-${completedAdmissionCount}`),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: runtimeSessions[0]?.provider ?? "codex",
            providerInstanceId: modelSelection.instanceId,
            runtimeMode: runtimeSessions[0]?.runtimeMode ?? "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: completedAt,
          },
          createdAt: completedAt,
        });
        if (acceptedMessageId !== null) {
          yield* turns.completeAcceptedTurnStartPhase({
            threadId,
            messageId: acceptedMessageId,
            phase: "runtime-admitted",
          });
          yield* turns.deletePendingTurnStart({ threadId, messageId: acceptedMessageId });
          yield* finalizeNotebookDocumentAuthorityTurn({
            threadId,
            messageId: acceptedMessageId,
          });
        }
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-session-ready-${tag}-${completedAdmissionCount}`),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: runtimeSessions[0]?.provider ?? "codex",
            providerInstanceId: modelSelection.instanceId,
            runtimeMode: runtimeSessions[0]?.runtimeMode ?? "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: completedAt,
          },
          createdAt: completedAt,
        });
      });

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      snapshotQuery,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      runtimeSessions,
      turns,
      listSessions,
      emitRuntimeEvent: (event: ProviderRuntimeEvent) =>
        Effect.runSync(PubSub.publish(runtimeEventPubSub, event)),
      lifecycleCalls,
      setNotebookDocumentAuthority,
      stageNotebookDocumentAuthorityTurn,
      completeNotebookDocumentAuthorityTurn,
      admitNotebookDocumentAuthorityTurn,
      finalizeNotebookDocumentAuthorityTurn,
      rollbackNotebookDocumentAuthorityTurn,
      readNotebookDocumentAuthority: () => [...notebookDocumentIds],
      authorityExposures,
      stateDir,
      drain,
      drainIngestion,
      completeAcceptedTurn,
    };
  }

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        documentIds: ["b".repeat(64), "a".repeat(64)],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.lifecycleCalls.slice(0, 2)).toEqual([
      `authority-stage:${"a".repeat(64)},${"b".repeat(64)}`,
      "start-session",
    ]);
    await waitFor(() => harness.completeNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    expect(harness.readNotebookDocumentAuthority()).toEqual([]);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("keeps a held turn's authority stable, rejects overlap, and rebinds sequentially", async () => {
    const priorDocumentId = "0".repeat(64);
    const documentA = "a".repeat(64);
    const documentB = "b".repeat(64);
    const messageA = asMessageId("user-message-authority-a");
    const harness = await createHarness({ initialNotebookDocumentIds: [priorDocumentId] });
    const sendEntered = Effect.runSync(Deferred.make<void>());
    const releaseSend = Effect.runSync(Deferred.make<void>());
    harness.sendTurn.mockImplementationOnce(() =>
      Deferred.succeed(sendEntered, undefined).pipe(
        Effect.andThen(Deferred.await(releaseSend)),
        Effect.as({
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-a"),
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-authority-a"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: messageA,
          role: "user",
          text: "run with document A",
          attachments: [],
        },
        documentIds: [documentA],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await Effect.runPromise(Deferred.await(sendEntered));
    expect(harness.readNotebookDocumentAuthority()).toEqual([priorDocumentId]);
    expect(harness.authorityExposures).toEqual([[priorDocumentId]]);
    const sessionBeforeOverlap = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    )?.session;

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-authority-overlap-b"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-authority-overlap-b"),
          role: "user",
          text: "overlap with document B",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.start.failed" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            "detail" in activity.payload &&
            typeof activity.payload.detail === "string" &&
            activity.payload.detail.includes("active or pending provider turn"),
        ) === true
      );
    });
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.stageNotebookDocumentAuthorityTurn).toHaveBeenCalledTimes(1);
    expect(harness.readNotebookDocumentAuthority()).toEqual([priorDocumentId]);
    expect(harness.authorityExposures).toEqual([[priorDocumentId]]);
    const sessionAfterOverlap = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    )?.session;
    expect(sessionAfterOverlap).toEqual(sessionBeforeOverlap);

    await Effect.runPromise(Deferred.succeed(releaseSend, undefined));
    await waitFor(() => harness.completeNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    expect(harness.readNotebookDocumentAuthority()).toEqual([priorDocumentId]);
    expect(harness.authorityExposures).not.toContainEqual([documentB]);

    await Effect.runPromise(
      harness.admitNotebookDocumentAuthorityTurn({
        threadId: ThreadId.make("thread-1"),
        messageId: messageA,
      }),
    );

    if (harness.runtimeSessions[0]) {
      harness.runtimeSessions[0] = {
        ...harness.runtimeSessions[0],
        status: "running",
        activeTurnId: asTurnId("turn-a"),
      };
    }
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-running-authority-a"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-a"),
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    const completedRuntimeAdmission = await Effect.runPromise(
      harness.turns.completeAcceptedTurnStartPhase({
        threadId: ThreadId.make("thread-1"),
        messageId: messageA,
        phase: "runtime-admitted",
      }),
    );
    expect(Option.getOrThrow(completedRuntimeAdmission).messageId).toBe(messageA);
    await Effect.runPromise(
      harness.turns.deletePendingTurnStart({
        threadId: ThreadId.make("thread-1"),
        messageId: messageA,
      }),
    );
    await Effect.runPromise(
      harness.finalizeNotebookDocumentAuthorityTurn({
        threadId: ThreadId.make("thread-1"),
        messageId: messageA,
      }),
    );
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentA]);
    const activeSessionBeforeRejection = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    )?.session;
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-authority-active-b"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-authority-active-b"),
          role: "user",
          text: "reject document B while A is active",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.500Z",
      }),
    );
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        thread?.activities.filter((activity) => activity.kind === "provider.turn.start.failed")
          .length === 2
      );
    });
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.stageNotebookDocumentAuthorityTurn).toHaveBeenCalledTimes(1);
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentA]);
    expect(
      (await harness.readModel()).threads.find((entry) => entry.id === ThreadId.make("thread-1"))
        ?.session,
    ).toEqual(activeSessionBeforeRejection);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-clear-authority-a"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    if (harness.runtimeSessions[0]) {
      const { activeTurnId: _activeTurnId, ...readySession } = harness.runtimeSessions[0];
      harness.runtimeSessions[0] = readySession;
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-authority-sequential-b"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-authority-sequential-b"),
          role: "user",
          text: "now run with document B",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await waitFor(() => harness.completeNotebookDocumentAuthorityTurn.mock.calls.length === 2);
    await Effect.runPromise(harness.completeAcceptedTurn("authority-sequential-b"));
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentB]);
  });

  it("binds delayed runtime admission to accepted A after projected B is rejected", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const sourceThreadId = ThreadId.make("thread-source-plan-a");
    const sourceTurnId = asTurnId("turn-source-plan-a");
    const turnA = asTurnId("turn-admission-a");
    const messageA = asMessageId("user-message-admission-a");
    const messageB = asMessageId("user-message-admission-b");
    const documentA = "a".repeat(64);
    const documentB = "b".repeat(64);
    const sendEntered = Effect.runSync(Deferred.make<void>());
    const releaseSend = Effect.runSync(Deferred.make<void>());
    const ingestionHeld = Effect.runSync(Deferred.make<void>());
    const releaseIngestion = Effect.runSync(Deferred.make<void>());

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-source-plan-a"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Source plan A",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    harness.emitRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: EventId.make("evt-source-plan-a-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Accepted plan A",
      },
    });
    await waitFor(async () => {
      const sourceThread = (await harness.readModel()).threads.find(
        (thread) => thread.id === sourceThreadId,
      );
      return sourceThread?.proposedPlans.length === 1;
    });
    const sourcePlan = (await harness.readModel()).threads
      .find((thread) => thread.id === sourceThreadId)
      ?.proposedPlans.at(0);
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan A to be projected.");
    }

    harness.sendTurn.mockImplementationOnce((_input, onAccepted) =>
      (onAccepted?.({ threadId, turnId: turnA }) ?? Effect.void).pipe(
        Effect.andThen(Deferred.succeed(sendEntered, undefined)),
        Effect.andThen(Deferred.await(releaseSend)),
        Effect.as({ threadId, turnId: turnA }),
      ),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-admission-a"),
        threadId,
        message: {
          messageId: messageA,
          role: "user",
          text: "implement accepted plan A",
          attachments: [],
        },
        documentIds: [documentA],
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(Deferred.await(sendEntered));

    const getAcceptedTurnStart = harness.turns.getAcceptedTurnStartByThreadId.bind(harness.turns);
    vi.spyOn(harness.turns, "getAcceptedTurnStartByThreadId").mockImplementationOnce((input) =>
      Deferred.succeed(ingestionHeld, undefined).pipe(
        Effect.andThen(Deferred.await(releaseIngestion)),
        Effect.andThen(getAcceptedTurnStart(input)),
      ),
    );
    const runtimeSession = harness.runtimeSessions.find((session) => session.threadId === threadId);
    expect(runtimeSession).toBeDefined();
    if (!runtimeSession) {
      throw new Error("Expected the provider session for A to exist.");
    }
    Object.assign(runtimeSession, {
      status: "running" as const,
      activeTurnId: turnA,
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-admission-a"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId,
      turnId: turnA,
      payload: {},
    });
    await Effect.runPromise(Deferred.await(ingestionHeld));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-admission-b"),
        threadId,
        message: {
          messageId: messageB,
          role: "user",
          text: "reject overlapping B",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await waitFor(async () => {
      const targetThread = (await harness.readModel()).threads.find(
        (thread) => thread.id === threadId,
      );
      return (
        targetThread?.activities.some(
          (activity) => activity.kind === "provider.turn.start.failed",
        ) === true
      );
    });
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.stageNotebookDocumentAuthorityTurn).toHaveBeenCalledTimes(1);
    const acceptedBeforeRuntimeIngestion = await Effect.runPromise(
      harness.turns.getAcceptedTurnStartByThreadId({ threadId }),
    );
    expect(
      acceptedBeforeRuntimeIngestion._tag === "Some"
        ? acceptedBeforeRuntimeIngestion.value.messageId
        : null,
    ).toBe(messageA);
    expect(
      (await Effect.runPromise(harness.turns.getPendingTurnStartByThreadId({ threadId })))._tag,
    ).toBe("None");

    await Effect.runPromise(Deferred.succeed(releaseIngestion, undefined));
    await harness.drainIngestion();
    await waitFor(async () => {
      const targetThread = (await harness.readModel()).threads.find(
        (thread) => thread.id === threadId,
      );
      return targetThread?.session?.activeTurnId === turnA;
    });

    expect(harness.admitNotebookDocumentAuthorityTurn).toHaveBeenCalledTimes(1);
    expect(harness.admitNotebookDocumentAuthorityTurn).toHaveBeenCalledWith({
      threadId,
      messageId: messageA,
    });
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentA]);
    expect(harness.authorityExposures).not.toContainEqual([documentB]);
    const readModel = await harness.readModel();
    const sourceThread = readModel.threads.find((thread) => thread.id === sourceThreadId);
    expect(sourceThread?.proposedPlans.find((plan) => plan.id === sourcePlan.id)).toMatchObject({
      implementationThreadId: threadId,
    });
    const targetThread = readModel.threads.find((thread) => thread.id === threadId);
    expect(targetThread?.latestTurn).toMatchObject({
      turnId: turnA,
      state: "running",
      sourceProposedPlan: {
        threadId: sourceThreadId,
        planId: sourcePlan.id,
      },
    });
    expect(
      Option.getOrThrow(
        await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })),
      ),
    ).toMatchObject({
      messageId: messageA,
      providerSendCompleted: false,
      runtimeAdmitted: true,
    });
    expect(
      (await Effect.runPromise(harness.turns.getPendingTurnStartByThreadId({ threadId })))._tag,
    ).toBe("None");

    await Effect.runPromise(Deferred.succeed(releaseSend, undefined));
    await waitFor(() => harness.completeNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    await waitFor(() => harness.finalizeNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    expect(
      (await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })))._tag,
    ).toBe("None");
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentA]);
  });

  it("reconciles provider-send-first A after delayed runtime admission and admits sequential B", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const messageA = asMessageId("user-message-send-first-a");
    const messageB = asMessageId("user-message-send-first-overlap-b");
    const messageSequentialB = asMessageId("user-message-send-first-sequential-b");
    const turnA = asTurnId("turn-send-first-a");
    const turnB = asTurnId("turn-send-first-sequential-b");
    const documentA = "a".repeat(64);
    const documentB = "b".repeat(64);
    harness.sendTurn.mockImplementationOnce(() => Effect.succeed({ threadId, turnId: turnA }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-send-first-a"),
        threadId,
        message: {
          messageId: messageA,
          role: "user",
          text: "send A before runtime admission",
          attachments: [],
        },
        documentIds: [documentA],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.completeNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    expect(harness.readNotebookDocumentAuthority()).toEqual([]);
    expect(
      Option.getOrThrow(
        await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })),
      ),
    ).toMatchObject({
      messageId: messageA,
      providerSendCompleted: true,
      runtimeAdmitted: false,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-send-first-overlap-b"),
        threadId,
        message: {
          messageId: messageB,
          role: "user",
          text: "overlapping B must be rejected",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await waitFor(async () => {
      const target = (await harness.readModel()).threads.find((thread) => thread.id === threadId);
      return (
        target?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ===
        true
      );
    });
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);

    const runtimeSession = harness.runtimeSessions.find((session) => session.threadId === threadId);
    expect(runtimeSession).toBeDefined();
    if (!runtimeSession) throw new Error("Expected provider session for send-first A.");
    Object.assign(runtimeSession, {
      status: "running" as const,
      activeTurnId: turnA,
      updatedAt: "2026-01-01T00:00:03.000Z",
    });
    harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-send-first-a"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId,
      turnId: turnA,
      payload: {},
    });
    await harness.drainIngestion();
    await waitFor(async () => {
      const target = (await harness.readModel()).threads.find((thread) => thread.id === threadId);
      return target?.session?.activeTurnId === turnA;
    });
    expect(harness.admitNotebookDocumentAuthorityTurn).toHaveBeenCalledWith({
      threadId,
      messageId: messageA,
    });
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentA]);
    expect(
      (await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })))._tag,
    ).toBe("None");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-ready-send-first-a"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:04.000Z",
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    const { activeTurnId: _activeTurnId, ...readyRuntimeSession } = runtimeSession;
    Object.assign(runtimeSession, readyRuntimeSession, { status: "ready" as const });
    delete (runtimeSession as { activeTurnId?: TurnId }).activeTurnId;
    harness.sendTurn.mockImplementationOnce(() => Effect.succeed({ threadId, turnId: turnB }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-send-first-sequential-b"),
        threadId,
        message: {
          messageId: messageSequentialB,
          role: "user",
          text: "sequential B may now start",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:05.000Z",
      }),
    );
    await waitFor(() => harness.completeNotebookDocumentAuthorityTurn.mock.calls.length === 2);
    Object.assign(runtimeSession, {
      status: "running" as const,
      activeTurnId: turnB,
      updatedAt: "2026-01-01T00:00:06.000Z",
    });
    harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-send-first-sequential-b"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:06.000Z",
      threadId,
      turnId: turnB,
      payload: {},
    });
    await harness.drainIngestion();
    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentB]);
  });

  it("replays a deferred runtime-admission phase before admitting same-process B", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const messageA = asMessageId("user-message-runtime-phase-retry-a");
    const messageB = asMessageId("user-message-runtime-phase-retry-b");
    const turnA = asTurnId("turn-runtime-phase-retry-a");
    const turnB = asTurnId("turn-runtime-phase-retry-b");
    const documentA = "a".repeat(64);
    const documentB = "b".repeat(64);
    harness.sendTurn.mockImplementationOnce(() => Effect.succeed({ threadId, turnId: turnA }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-runtime-phase-retry-a"),
        threadId,
        message: {
          messageId: messageA,
          role: "user",
          text: "project A before the runtime phase write succeeds",
          attachments: [],
        },
        documentIds: [documentA],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.completeNotebookDocumentAuthorityTurn.mock.calls.length === 1);

    const completeAcceptedTurnStartPhase = harness.turns.completeAcceptedTurnStartPhase;
    let rejectedRuntimePhaseWrites = 0;
    vi.spyOn(harness.turns, "completeAcceptedTurnStartPhase").mockImplementation((input) => {
      if (input.phase === "runtime-admitted" && rejectedRuntimePhaseWrites === 0) {
        rejectedRuntimePhaseWrites += 1;
        return Effect.die(
          new Error("injected first runtime-admission phase write failure"),
        ) as never;
      }
      return completeAcceptedTurnStartPhase(input);
    });

    const runtimeSession = harness.runtimeSessions.find((session) => session.threadId === threadId);
    expect(runtimeSession).toBeDefined();
    if (!runtimeSession) throw new Error("Expected provider session for runtime-phase A.");
    Object.assign(runtimeSession, {
      status: "running" as const,
      activeTurnId: turnA,
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: EventId.make("evt-runtime-phase-retry-a-started"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId,
      turnId: turnA,
      payload: {},
    });
    await harness.drainIngestion();

    expect(rejectedRuntimePhaseWrites).toBe(1);
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentA]);
    expect(
      Option.getOrThrow(
        await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })),
      ),
    ).toMatchObject({
      messageId: messageA,
      providerSendCompleted: true,
      runtimeAdmitted: false,
    });
    expect(
      Option.getOrThrow(
        await Effect.runPromise(harness.turns.getByTurnId({ threadId, turnId: turnA })),
      ).pendingMessageId,
    ).toBe(messageA);

    const { activeTurnId: _activeTurnId, ...readyRuntimeSession } = runtimeSession;
    Object.assign(runtimeSession, readyRuntimeSession, {
      status: "ready" as const,
      updatedAt: "2026-01-01T00:00:03.000Z",
    });
    delete (runtimeSession as { activeTurnId?: TurnId }).activeTurnId;
    harness.emitRuntimeEvent({
      type: "turn.completed",
      eventId: EventId.make("evt-runtime-phase-retry-a-completed"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId,
      turnId: turnA,
      payload: { state: "completed" },
    });
    await harness.drainIngestion();
    harness.sendTurn.mockImplementationOnce(() => Effect.succeed({ threadId, turnId: turnB }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-runtime-phase-retry-b"),
        threadId,
        message: {
          messageId: messageB,
          role: "user",
          text: "start B after replaying exact A",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    await harness.drain();
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    expect(
      Option.getOrThrow(
        await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })),
      ).messageId,
    ).toBe(messageB);

    Object.assign(runtimeSession, {
      status: "running" as const,
      activeTurnId: turnB,
      updatedAt: "2026-01-01T00:00:05.000Z",
    });
    harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: EventId.make("evt-runtime-phase-retry-b-started"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:05.000Z",
      threadId,
      turnId: turnB,
      payload: {},
    });
    await harness.drainIngestion();
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentB]);
    expect(
      (await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })))._tag,
    ).toBe("None");
  });

  it("rejects queued late A after send failure and admits B across reactor and ingestion workers", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const sourceThreadId = ThreadId.make("thread-late-cancelled-source-plan");
    const sourceTurnId = asTurnId("turn-late-cancelled-source-plan");
    const messageA = asMessageId("user-message-late-cancelled-a");
    const messageB = asMessageId("user-message-after-late-cancelled-b");
    const turnA = asTurnId("turn-late-cancelled-a");
    const turnB = asTurnId("turn-after-late-cancelled-b");
    const documentA = "a".repeat(64);
    const documentB = "b".repeat(64);
    const sendEntered = Effect.runSync(Deferred.make<void>());
    const releaseSend = Effect.runSync(Deferred.make<void>());
    const ingestionHeld = Effect.runSync(Deferred.make<void>());
    const releaseIngestion = Effect.runSync(Deferred.make<void>());

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-late-cancelled-source-plan"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Late cancelled source plan",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    harness.emitRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: EventId.make("evt-late-cancelled-source-plan-completed"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Late cancelled source plan",
      },
    });
    await waitFor(async () => {
      const sourceThread = (await harness.readModel()).threads.find(
        (thread) => thread.id === sourceThreadId,
      );
      return sourceThread?.proposedPlans.length === 1;
    });
    const sourcePlan = (await harness.readModel()).threads
      .find((thread) => thread.id === sourceThreadId)
      ?.proposedPlans.at(0);
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) throw new Error("Expected the late-cancelled source plan.");

    harness.sendTurn.mockImplementationOnce(
      (_input, onAccepted) =>
        (onAccepted?.({ threadId, turnId: turnA }) ?? Effect.void).pipe(
          Effect.andThen(Deferred.succeed(sendEntered, undefined)),
          Effect.andThen(Deferred.await(releaseSend)),
          Effect.andThen(
            Effect.sync(() => {
              const failedSession = harness.runtimeSessions.find(
                (session) => session.threadId === threadId,
              );
              if (failedSession !== undefined) {
                Object.assign(failedSession, { status: "ready" as const });
                delete (failedSession as { activeTurnId?: TurnId }).activeTurnId;
              }
            }),
          ),
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "thread.turn.start",
                detail: "injected send rejection after queued turn.started",
              }),
            ),
          ),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-late-cancelled-a"),
        threadId,
        message: {
          messageId: messageA,
          role: "user",
          text: "queue A before send rejection",
          attachments: [],
        },
        documentIds: [documentA],
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await Effect.runPromise(Deferred.await(sendEntered));

    const runtimeSession = harness.runtimeSessions.find((session) => session.threadId === threadId);
    expect(runtimeSession).toBeDefined();
    if (!runtimeSession) throw new Error("Expected provider session for cancelled A.");
    Object.assign(runtimeSession, {
      status: "running" as const,
      activeTurnId: turnA,
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    const getAcceptedTurnStart = harness.turns.getAcceptedTurnStartByThreadId.bind(harness.turns);
    vi.spyOn(harness.turns, "getAcceptedTurnStartByThreadId").mockImplementationOnce((input) =>
      Deferred.succeed(ingestionHeld, undefined).pipe(
        Effect.andThen(Deferred.await(releaseIngestion)),
        Effect.andThen(getAcceptedTurnStart(input)),
      ),
    );
    harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: EventId.make("evt-late-cancelled-a-started"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId,
      turnId: turnA,
      payload: {},
    });
    await Effect.runPromise(Deferred.await(ingestionHeld));

    await Effect.runPromise(Deferred.succeed(releaseSend, undefined));
    await waitFor(() => harness.rollbackNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    await Effect.runPromise(Deferred.succeed(releaseIngestion, undefined));
    await harness.drainIngestion();
    await harness.drain();

    expect(
      Option.getOrThrow(
        await Effect.runPromise(
          harness.turns.getCancelledTurnStartByProviderTurn({
            threadId,
            providerTurnId: turnA,
          }),
        ),
      ).messageId,
    ).toBe(messageA);
    expect(
      (await Effect.runPromise(harness.turns.getByTurnId({ threadId, turnId: turnA })))._tag,
    ).toBe("None");
    expect(harness.readNotebookDocumentAuthority()).toEqual([]);
    expect(harness.admitNotebookDocumentAuthorityTurn).not.toHaveBeenCalledWith({
      threadId,
      messageId: messageA,
    });
    const readModelAfterCancelledA = await harness.readModel();
    expect(
      readModelAfterCancelledA.threads.find((thread) => thread.id === sourceThreadId)
        ?.proposedPlans,
    ).toContainEqual(
      expect.objectContaining({
        id: sourcePlan.id,
        implementedAt: null,
        implementationThreadId: null,
      }),
    );
    expect(
      readModelAfterCancelledA.threads.find((thread) => thread.id === threadId)?.session,
    ).toMatchObject({
      status: "ready",
      activeTurnId: null,
    });

    harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: EventId.make("evt-late-cancelled-a-duplicate"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId,
      turnId: turnA,
      payload: {},
    });
    await harness.drainIngestion();
    expect(
      (await Effect.runPromise(harness.turns.getByTurnId({ threadId, turnId: turnA })))._tag,
    ).toBe("None");

    const { activeTurnId: _cancelledTurnId, ...readyRuntimeSession } = runtimeSession;
    Object.assign(runtimeSession, readyRuntimeSession, {
      status: "ready" as const,
      updatedAt: "2026-01-01T00:00:04.000Z",
    });
    delete (runtimeSession as { activeTurnId?: TurnId }).activeTurnId;
    harness.sendTurn.mockImplementationOnce(() => Effect.succeed({ threadId, turnId: turnB }));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-after-late-cancelled-b"),
        threadId,
        message: {
          messageId: messageB,
          role: "user",
          text: "start B after rejecting late A",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    Object.assign(runtimeSession, {
      status: "running" as const,
      activeTurnId: turnB,
      updatedAt: "2026-01-01T00:00:05.000Z",
    });
    harness.emitRuntimeEvent({
      type: "turn.started",
      eventId: EventId.make("evt-after-late-cancelled-b-started"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:05.000Z",
      threadId,
      turnId: turnB,
      payload: {},
    });
    await harness.drainIngestion();
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentB]);
  });

  it("clears exact acquired guards when post-stage project resolution fails", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    vi.spyOn(harness.snapshotQuery, "getProjectShellById").mockImplementationOnce(
      () => Effect.die(new Error("injected post-stage resolveProject failure")) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-post-stage-project-failure-a"),
        threadId,
        message: {
          messageId: asMessageId("user-message-post-stage-project-failure-a"),
          role: "user",
          text: "fail after staging A",
          attachments: [],
        },
        documentIds: ["a".repeat(64)],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.rollbackNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(
      (await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })))._tag,
    ).toBe("None");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-post-stage-project-failure-b"),
        threadId,
        message: {
          messageId: asMessageId("user-message-post-stage-project-failure-b"),
          role: "user",
          text: "B starts after A cleanup",
          attachments: [],
        },
        documentIds: ["b".repeat(64)],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
  });

  it("releases registry and local guards even when both durable failure deletes fail", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const messageA = asMessageId("user-message-cleanup-delete-failure-a");
    const messageB = asMessageId("user-message-cleanup-delete-failure-b");
    vi.spyOn(harness.turns, "deleteAcceptedTurnStart").mockImplementationOnce(
      () => Effect.die(new Error("injected accepted cleanup failure")) as never,
    );
    vi.spyOn(harness.turns, "deletePendingTurnStart").mockImplementationOnce(
      () => Effect.die(new Error("injected pending cleanup failure")) as never,
    );
    harness.sendTurn.mockImplementationOnce(
      () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread.turn.start",
            detail: "injected provider send failure",
          }),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-cleanup-delete-failure-a"),
        threadId,
        message: {
          messageId: messageA,
          role: "user",
          text: "leave durable A orphan",
          attachments: [],
        },
        documentIds: ["a".repeat(64)],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.rollbackNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    expect(
      Option.getOrThrow(
        await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })),
      ).messageId,
    ).toBe(messageA);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-cleanup-delete-failure-b"),
        threadId,
        message: {
          messageId: messageB,
          role: "user",
          text: "reconcile orphan and start B",
          attachments: [],
        },
        documentIds: ["b".repeat(64)],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(
      Option.getOrThrow(
        await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })),
      ).messageId,
    ).toBe(messageB);
  });

  it("reconciles a durable accepted orphan after restart before admitting B", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const orphanMessageId = asMessageId("user-message-restart-orphan-a");
    const messageB = asMessageId("user-message-restart-b");
    expect(
      await Effect.runPromise(
        harness.turns.stageAcceptedTurnStart({
          threadId,
          messageId: orphanMessageId,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          requestedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe(true);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-restart-orphan-b"),
        threadId,
        message: {
          messageId: messageB,
          role: "user",
          text: "start B after restart",
          attachments: [],
        },
        documentIds: ["b".repeat(64)],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(
      Option.getOrThrow(
        await Effect.runPromise(harness.turns.getAcceptedTurnStartByThreadId({ threadId })),
      ).messageId,
    ).toBe(messageB);
  });

  it("preserves prior notebook authority when session construction fails", async () => {
    const documentA = "a".repeat(64);
    const documentB = "b".repeat(64);
    const harness = await createHarness({ initialNotebookDocumentIds: [documentA] });
    harness.startSession.mockImplementationOnce(
      () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread.turn.start",
            detail: "session construction failed",
          }),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-authority-construction-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-authority-construction-failure"),
          role: "user",
          text: "construction failure",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.rollbackNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.completeNotebookDocumentAuthorityTurn).not.toHaveBeenCalled();
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentA]);
    expect(harness.authorityExposures).toEqual([[documentA]]);
  });

  it("preserves prior notebook authority without transient exposure when sendTurn fails", async () => {
    const documentA = "a".repeat(64);
    const documentB = "b".repeat(64);
    const harness = await createHarness({ initialNotebookDocumentIds: [documentA] });
    harness.sendTurn.mockImplementationOnce(
      () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread.turn.start",
            detail: "send turn failed",
          }),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-authority-send-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-authority-send-failure"),
          role: "user",
          text: "send failure",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.rollbackNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.completeNotebookDocumentAuthorityTurn).not.toHaveBeenCalled();
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentA]);
    expect(harness.authorityExposures).toEqual([[documentA]]);
  });

  it("restores prior notebook authority when an admitted sendTurn later fails", async () => {
    const documentA = "a".repeat(64);
    const documentB = "b".repeat(64);
    const messageId = asMessageId("user-message-authority-admitted-send-failure");
    const harness = await createHarness({ initialNotebookDocumentIds: [documentA] });
    const sendEntered = Effect.runSync(Deferred.make<void>());
    const releaseFailure = Effect.runSync(Deferred.make<void>());
    harness.sendTurn.mockImplementationOnce(
      () =>
        Deferred.succeed(sendEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFailure)),
          Effect.andThen(
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "thread.turn.start",
                detail: "admitted send turn failed",
              }),
            ),
          ),
        ) as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-authority-admitted-send-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId,
          role: "user",
          text: "admitted send failure",
          attachments: [],
        },
        documentIds: [documentB],
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await Effect.runPromise(Deferred.await(sendEntered));
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentA]);
    await Effect.runPromise(
      harness.admitNotebookDocumentAuthorityTurn({
        threadId: ThreadId.make("thread-1"),
        messageId,
      }),
    );
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentB]);

    await Effect.runPromise(Deferred.succeed(releaseFailure, undefined));
    await waitFor(() => harness.rollbackNotebookDocumentAuthorityTurn.mock.calls.length === 1);
    expect(harness.completeNotebookDocumentAuthorityTurn).not.toHaveBeenCalled();
    expect(harness.readNotebookDocumentAuthority()).toEqual([documentA]);
    expect(harness.authorityExposures).toEqual([[documentA], [documentB], [documentA]]);
  });

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
  });

  it("forwards codex model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-fast"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-fast"),
          role: "user",
          text: "hello fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    });
  });

  it("forwards claude effort options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort"),
          role: "user",
          text: "hello with effort",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("forwards claude fast mode options through session start and turn send", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-fast-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-fast-mode"),
          role: "user",
          text: "hello with fast mode",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-opus-4-6",
        [{ id: "fastMode", value: true }],
      ),
    });
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(harness.completeAcceptedTurn("unsupported-model"));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  effectIt.effect(
    "rejects changing models after start when the provider requires a new thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ requiresNewThreadForModelChange: true }),
        );
        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-1"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-1"),
            role: "user",
            text: "first",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() => waitFor(() => harness.sendTurn.mock.calls.length === 1));

        yield* harness.completeAcceptedTurn("restricted-model");

        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start-restricted-2"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("user-message-restricted-2"),
            role: "user",
            text: "second",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.1-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        });

        yield* Effect.promise(() =>
          waitFor(async () => {
            const readModel = await harness.readModel();
            const thread = readModel.threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );
            return (
              thread?.activities.some(
                (activity) => activity.kind === "provider.turn.start.failed",
              ) ?? false
            );
          }),
        );

        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        const readModel = yield* Effect.promise(() => harness.readModel());
        const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
        ).toMatchObject({
          payload: {
            detail: expect.stringContaining(
              "cannot switch models after the conversation has started",
            ),
          },
        });
      }),
  );

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(harness.completeAcceptedTurn("unchanged-runtime"));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(harness.completeAcceptedTurn("compatible-codex"));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });
    await Effect.runPromise(harness.completeAcceptedTurn("workspace-change"));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(harness.completeAcceptedTurn("claude-effort"));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(harness.completeAcceptedTurn("runtime-mode"));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("rejects provider changes after a thread is already bound to a session provider", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(harness.completeAcceptedTurn("provider-switch"));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("codex");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("rejects cross-driver provider changes after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("cannot switch to 'claudeAgent'"),
      },
    });
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces non-resumable provider user-input callbacks as stale failures", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending Codex user input request: user-input-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });
});
