import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { StudyDocumentId } from "./study.ts";
import { NotebookExecutionEvent } from "./notebook.ts";
import {
  NotebookCellId,
  NotebookContentHash,
  NotebookDocumentId,
  NotebookRevisionId,
} from "@t3tools/lightfast-artifact-notebook/contracts";

const BoundedName = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedText = Schema.String.check(Schema.isMaxLength(1_000_000));
const Score = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const StudyArtifactHash = TrimmedNonEmptyString.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type StudyArtifactHash = typeof StudyArtifactHash.Type;

export const StudyTraceRunId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(160),
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/i),
);
export type StudyTraceRunId = typeof StudyTraceRunId.Type;

export const StudySkillArtifactRef = Schema.Struct({
  name: BoundedName,
  version: BoundedName,
  contentHash: StudyArtifactHash,
  source: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
});
export type StudySkillArtifactRef = typeof StudySkillArtifactRef.Type;

export const StudyRuntimeEnvelope = Schema.Struct({
  adapter: Schema.Struct({
    id: BoundedName,
    version: BoundedName,
  }),
  model: Schema.Struct({
    provider: BoundedName,
    name: BoundedName,
    settings: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  tools: Schema.Array(
    Schema.Struct({
      name: BoundedName,
      version: Schema.optional(BoundedName),
    }),
  ).check(Schema.isMaxLength(128)),
});
export type StudyRuntimeEnvelope = typeof StudyRuntimeEnvelope.Type;

export const StudyTraceEventType = Schema.Literals([
  "run_started",
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "state_changed",
  "interruption",
  "environment_observation",
  "checkpoint",
  "notebook_execution",
  "run_finished",
]);
export type StudyTraceEventType = typeof StudyTraceEventType.Type;

export const StudyNotebookOperation = Schema.Literals(["execute_cell", "execute_all"]);
export type StudyNotebookOperation = typeof StudyNotebookOperation.Type;

export const StudyNotebookRuntimeEventType = Schema.Literals([
  "accepted",
  "rejected",
  "kernel",
  "execution",
  "stream",
  "display",
  "result",
  "error",
  "limit",
]);
export type StudyNotebookRuntimeEventType = typeof StudyNotebookRuntimeEventType.Type;

export const StudyNotebookCommandType = Schema.Literals(["open", "execute", "dispose"]);
export type StudyNotebookCommandType = typeof StudyNotebookCommandType.Type;

export const StudyNotebookBinding = Schema.Struct({
  documentId: NotebookDocumentId,
  revisionId: NotebookRevisionId,
  contentHash: NotebookContentHash,
  runtimeImageDigest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  kernelLockHash: StudyArtifactHash,
  kernelName: BoundedName,
});
export type StudyNotebookBinding = typeof StudyNotebookBinding.Type;

export const StudyNotebookCommand = Schema.Struct({
  type: StudyNotebookCommandType,
  commandId: BoundedName,
  executionId: Schema.optional(BoundedName),
  cellId: Schema.optional(NotebookCellId),
  codeHash: Schema.optional(StudyArtifactHash),
  startedAt: IsoDateTime,
});
export type StudyNotebookCommand = typeof StudyNotebookCommand.Type;

export const StudyNotebookExecutionEvent = Schema.Struct({
  type: Schema.Literal("notebook_execution"),
  operation: StudyNotebookOperation,
  outcome: Schema.Literals(["completed", "failed"]),
  permissionGranted: Schema.Literal(true),
  binding: StudyNotebookBinding,
  sessionId: BoundedName,
  isolation: Schema.Struct({
    session: Schema.Literal("ephemeral-exclusive"),
    network: Schema.Literal("disabled"),
    hostWorkspace: Schema.Literal("not-mounted"),
  }),
  commands: Schema.Array(StudyNotebookCommand).check(Schema.isMaxLength(2_002)),
  runtimeEvents: Schema.Array(NotebookExecutionEvent).check(Schema.isMaxLength(16_384)),
  outputHash: StudyArtifactHash,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  cleanup: Schema.Struct({
    attempted: Schema.Boolean,
    succeeded: Schema.Boolean,
    commandId: Schema.optional(BoundedName),
  }),
});
export type StudyNotebookExecutionEvent = typeof StudyNotebookExecutionEvent.Type;

export const StudyTraceEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("run_started"),
    skill: StudySkillArtifactRef,
    runtime: StudyRuntimeEnvelope,
    documentIds: Schema.Array(StudyDocumentId).check(Schema.isMaxLength(32)),
    caseId: Schema.optional(BoundedName),
  }),
  Schema.Struct({
    type: Schema.Literal("user_message"),
    text: BoundedText,
    modality: Schema.Literals(["text", "voice"]),
    confidence: Schema.optional(Score),
  }),
  Schema.Struct({
    type: Schema.Literal("assistant_message"),
    text: BoundedText,
    modality: Schema.Literals(["text", "voice"]),
    interrupted: Schema.Boolean,
    latencyMs: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call"),
    callId: BoundedName,
    name: BoundedName,
    arguments: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    callId: BoundedName,
    name: BoundedName,
    output: BoundedText,
    isError: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("state_changed"),
    actor: Schema.Literals(["user", "assistant", "environment"]),
    from: BoundedName,
    to: BoundedName,
  }),
  Schema.Struct({
    type: Schema.Literal("interruption"),
    source: Schema.Literals(["user", "assistant", "environment"]),
    resumed: Schema.optional(Schema.Boolean),
    detail: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  }),
  Schema.Struct({
    type: Schema.Literal("environment_observation"),
    adapter: BoundedName,
    observation: BoundedName,
    payload: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("checkpoint"),
    outcome: Schema.Literals(["accepted", "rejected", "corrected", "skipped"]),
    note: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))),
  }),
  StudyNotebookExecutionEvent,
  Schema.Struct({
    type: Schema.Literal("run_finished"),
    reason: Schema.Literals(["completed", "cancelled", "disconnected", "error"]),
    outcome: Schema.optional(BoundedName),
  }),
]);
export type StudyTraceEvent = typeof StudyTraceEvent.Type;

export const StudyTraceRecord = Schema.Struct({
  version: Schema.Literal(1),
  runId: StudyTraceRunId,
  sequence: NonNegativeInt,
  timestamp: IsoDateTime,
  previousHash: Schema.NullOr(StudyArtifactHash),
  event: StudyTraceEvent,
  hash: StudyArtifactHash,
});
export type StudyTraceRecord = typeof StudyTraceRecord.Type;

export const StudyTraceEventMatcher = Schema.Struct({
  eventType: StudyTraceEventType,
  toolName: Schema.optional(BoundedName),
  actor: Schema.optional(Schema.Literals(["user", "assistant", "environment"])),
  textIncludes: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
});
export type StudyTraceEventMatcher = typeof StudyTraceEventMatcher.Type;

const AssertionWeight = Schema.optional(
  Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
);

export const StudyEvalAssertion = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("event_count"),
    matcher: StudyTraceEventMatcher,
    min: NonNegativeInt,
    max: Schema.optional(NonNegativeInt),
    weight: AssertionWeight,
  }),
  Schema.Struct({
    type: Schema.Literal("event_order"),
    before: StudyTraceEventMatcher,
    after: StudyTraceEventMatcher,
    weight: AssertionWeight,
  }),
  Schema.Struct({
    type: Schema.Literal("max_latency"),
    from: StudyTraceEventMatcher,
    to: StudyTraceEventMatcher,
    maxMs: PositiveInt,
    weight: AssertionWeight,
  }),
  Schema.Struct({
    type: Schema.Literal("notebook_output_order"),
    operation: StudyNotebookOperation,
    commandOrder: Schema.Array(StudyNotebookCommandType).check(Schema.isMinLength(1)),
    runtimeEventOrder: Schema.Array(StudyNotebookRuntimeEventType).check(Schema.isMinLength(1)),
    outputHash: StudyArtifactHash,
    weight: AssertionWeight,
  }),
  Schema.Struct({
    type: Schema.Literal("notebook_max_latency"),
    operation: StudyNotebookOperation,
    maxMs: PositiveInt,
    weight: AssertionWeight,
  }),
  Schema.Struct({
    type: Schema.Literal("notebook_permission"),
    operation: StudyNotebookOperation,
    required: Schema.Boolean,
    weight: AssertionWeight,
  }),
  Schema.Struct({
    type: Schema.Literal("notebook_isolation"),
    operation: StudyNotebookOperation,
    weight: AssertionWeight,
  }),
  Schema.Struct({
    type: Schema.Literal("notebook_cleanup"),
    operation: StudyNotebookOperation,
    weight: AssertionWeight,
  }),
  Schema.Struct({
    type: Schema.Literal("notebook_identity"),
    operation: StudyNotebookOperation,
    binding: StudyNotebookBinding,
    weight: AssertionWeight,
  }),
]);
export type StudyEvalAssertion = typeof StudyEvalAssertion.Type;

export const StudyEvalAssertionType = Schema.Literals([
  "event_count",
  "event_order",
  "max_latency",
  "notebook_output_order",
  "notebook_max_latency",
  "notebook_permission",
  "notebook_isolation",
  "notebook_cleanup",
  "notebook_identity",
]);
export type StudyEvalAssertionType = typeof StudyEvalAssertionType.Type;

export const StudyEvalCase = Schema.Struct({
  id: BoundedName,
  title: BoundedName,
  split: Schema.Literals(["train", "holdout"]),
  traceId: Schema.optional(StudyTraceRunId),
  weight: Schema.optional(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
  ),
  assertions: Schema.Array(StudyEvalAssertion).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
});
export type StudyEvalCase = typeof StudyEvalCase.Type;

export const StudyEvalDataset = Schema.Struct({
  version: Schema.Literal(1),
  id: BoundedName,
  title: BoundedName,
  cases: Schema.Array(StudyEvalCase).check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
});
export type StudyEvalDataset = typeof StudyEvalDataset.Type;

export const StudyEvalAssertionResult = Schema.Struct({
  assertionIndex: NonNegativeInt,
  type: StudyEvalAssertionType,
  passed: Schema.Boolean,
  weight: Schema.Number,
  detail: Schema.String,
});
export type StudyEvalAssertionResult = typeof StudyEvalAssertionResult.Type;

export const StudyEvalCaseResult = Schema.Struct({
  caseId: BoundedName,
  traceId: StudyTraceRunId,
  split: Schema.Literals(["train", "holdout"]),
  passed: Schema.Boolean,
  score: Score,
  weight: Schema.Number,
  assertions: Schema.Array(StudyEvalAssertionResult),
  skill: StudySkillArtifactRef,
  runtime: StudyRuntimeEnvelope,
  traceIntegrityHash: StudyArtifactHash,
});
export type StudyEvalCaseResult = typeof StudyEvalCaseResult.Type;

export const StudyEvalSplitSummary = Schema.Struct({
  cases: NonNegativeInt,
  passed: NonNegativeInt,
  score: Score,
});
export type StudyEvalSplitSummary = typeof StudyEvalSplitSummary.Type;

export const StudyEvalReport = Schema.Struct({
  version: Schema.Literal(1),
  reportId: StudyTraceRunId,
  datasetId: BoundedName,
  datasetHash: StudyArtifactHash,
  grader: Schema.Struct({
    id: BoundedName,
    version: BoundedName,
  }),
  evaluatedAt: IsoDateTime,
  score: Score,
  passed: Schema.Boolean,
  splits: Schema.Struct({
    train: StudyEvalSplitSummary,
    holdout: StudyEvalSplitSummary,
  }),
  cases: Schema.Array(StudyEvalCaseResult),
});
export type StudyEvalReport = typeof StudyEvalReport.Type;

export const StudyPromotionPolicy = Schema.Struct({
  minimumOverallDelta: Schema.Number,
  minimumHoldoutDelta: Schema.Number,
  maximumRegressions: NonNegativeInt,
  requireCandidatePass: Schema.Boolean,
});
export type StudyPromotionPolicy = typeof StudyPromotionPolicy.Type;

export const StudyEvalComparison = Schema.Struct({
  version: Schema.Literal(1),
  datasetId: BoundedName,
  datasetHash: StudyArtifactHash,
  grader: Schema.Struct({
    id: BoundedName,
    version: BoundedName,
  }),
  policy: StudyPromotionPolicy,
  baselineReportId: StudyTraceRunId,
  candidateReportId: StudyTraceRunId,
  baselineReportHash: StudyArtifactHash,
  candidateReportHash: StudyArtifactHash,
  overallDelta: Schema.Number,
  trainDelta: Schema.Number,
  holdoutDelta: Schema.Number,
  improvements: Schema.Array(BoundedName),
  regressions: Schema.Array(BoundedName),
  promotable: Schema.Boolean,
  reasons: Schema.Array(Schema.String),
});
export type StudyEvalComparison = typeof StudyEvalComparison.Type;

export class StudyLoopError extends Schema.TaggedErrorClass<StudyLoopError>()("StudyLoopError", {
  operation: Schema.Literals(["read-trace", "write-trace", "evaluate", "compare"]),
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
