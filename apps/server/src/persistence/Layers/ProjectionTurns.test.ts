import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionTurnRepository } from "../Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "./ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionTurnRepository accepted starts", (it) => {
  it.effect("keeps accepted A when overlapping B tries to replace it", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionTurnRepository;
      const threadId = ThreadId.make("thread-accepted-replacement");
      const acceptedA = {
        threadId,
        messageId: MessageId.make("message-accepted-a"),
        sourceProposedPlanThreadId: ThreadId.make("thread-source-a"),
        sourceProposedPlanId: "plan-source-a",
        requestedAt: "2026-01-01T00:00:00.000Z",
      } as const;
      const overlappingB = {
        threadId,
        messageId: MessageId.make("message-overlapping-b"),
        sourceProposedPlanThreadId: ThreadId.make("thread-source-b"),
        sourceProposedPlanId: "plan-source-b",
        requestedAt: "2026-01-01T00:00:01.000Z",
      } as const;

      assert.isTrue(yield* repository.stageAcceptedTurnStart(acceptedA));
      assert.isFalse(yield* repository.stageAcceptedTurnStart(overlappingB));
      assert.deepEqual(
        Option.getOrThrow(yield* repository.getAcceptedTurnStartByThreadId({ threadId })),
        {
          ...acceptedA,
          providerSendCompleted: false,
          runtimeAdmitted: false,
        },
      );
    }),
  );

  it.effect("cleans accepted and pending starts only for the exact message", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionTurnRepository;
      const threadId = ThreadId.make("thread-exact-turn-start-cleanup");
      const messageA = MessageId.make("message-cleanup-a");
      const messageB = MessageId.make("message-cleanup-b");
      const acceptedA = {
        threadId,
        messageId: messageA,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: "2026-01-01T00:00:00.000Z",
      } as const;

      yield* repository.replacePendingTurnStart(acceptedA);
      yield* repository.replacePendingTurnStart({
        ...acceptedA,
        messageId: messageB,
        requestedAt: "2026-01-01T00:00:01.000Z",
      });
      assert.isTrue(yield* repository.stageAcceptedTurnStart(acceptedA));

      assert.isFalse(yield* repository.deleteAcceptedTurnStart({ threadId, messageId: messageB }));
      assert.isFalse(yield* repository.deletePendingTurnStart({ threadId, messageId: messageA }));
      assert.equal(
        Option.getOrThrow(yield* repository.getAcceptedTurnStartByThreadId({ threadId })).messageId,
        messageA,
      );
      assert.equal(
        Option.getOrThrow(yield* repository.getPendingTurnStartByThreadId({ threadId })).messageId,
        messageB,
      );

      assert.isTrue(yield* repository.deleteAcceptedTurnStart({ threadId, messageId: messageA }));
      assert.isTrue(yield* repository.deletePendingTurnStart({ threadId, messageId: messageB }));
      assert.isTrue(Option.isNone(yield* repository.getAcceptedTurnStartByThreadId({ threadId })));
      assert.isTrue(Option.isNone(yield* repository.getPendingTurnStartByThreadId({ threadId })));
    }),
  );

  it.effect("finalizes accepted A exactly once after send and runtime phases in either order", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionTurnRepository;
      const threadId = ThreadId.make("thread-accepted-phase-reconciliation");
      const messageA = MessageId.make("message-phase-a");
      const messageB = MessageId.make("message-phase-b");
      const acceptedA = {
        threadId,
        messageId: messageA,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        requestedAt: "2026-01-01T00:00:00.000Z",
      } as const;

      assert.isTrue(yield* repository.stageAcceptedTurnStart(acceptedA));
      assert.deepEqual(
        Option.getOrThrow(
          yield* repository.completeAcceptedTurnStartPhase({
            threadId,
            messageId: messageA,
            phase: "provider-send-completed",
          }),
        ),
        {
          ...acceptedA,
          providerSendCompleted: true,
          runtimeAdmitted: false,
          finalized: false,
        },
      );
      assert.isTrue(
        Option.isNone(
          yield* repository.completeAcceptedTurnStartPhase({
            threadId,
            messageId: messageB,
            phase: "runtime-admitted",
          }),
        ),
      );
      assert.equal(
        Option.getOrThrow(yield* repository.getAcceptedTurnStartByThreadId({ threadId })).messageId,
        messageA,
      );

      assert.deepEqual(
        Option.getOrThrow(
          yield* repository.completeAcceptedTurnStartPhase({
            threadId,
            messageId: messageA,
            phase: "runtime-admitted",
          }),
        ),
        {
          ...acceptedA,
          providerSendCompleted: true,
          runtimeAdmitted: true,
          finalized: true,
        },
      );
      assert.isTrue(Option.isNone(yield* repository.getAcceptedTurnStartByThreadId({ threadId })));
      assert.isTrue(
        Option.isNone(
          yield* repository.completeAcceptedTurnStartPhase({
            threadId,
            messageId: messageA,
            phase: "runtime-admitted",
          }),
        ),
      );

      assert.isTrue(
        yield* repository.stageAcceptedTurnStart({
          ...acceptedA,
          messageId: messageB,
          requestedAt: "2026-01-01T00:00:01.000Z",
        }),
      );
      assert.isFalse(
        Option.getOrThrow(yield* repository.getAcceptedTurnStartByThreadId({ threadId }))
          .providerSendCompleted,
      );
    }),
  );
});
