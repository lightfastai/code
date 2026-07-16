import * as NodeCrypto from "node:crypto";

import {
  StudyEvalDataset,
  StudyEvalReport,
  StudyLoopError,
  type StudyEvalAssertion,
  type StudyEvalAssertionResult,
  type StudyEvalCaseResult,
  type StudyEvalComparison,
  type StudyEvalSplitSummary,
  type StudyPromotionPolicy,
  type StudyTraceEvent,
  type StudyTraceEventMatcher,
  type StudyTraceRecord,
  type StudyTraceRunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { hashStudyValue, readStudyTrace, type StudyLoopPaths } from "./StudyTraceStore.ts";

const decodeDatasetJson = Schema.decodeUnknownEffect(Schema.fromJsonString(StudyEvalDataset));
const decodeReportJson = Schema.decodeUnknownEffect(Schema.fromJsonString(StudyEvalReport));
const encodeReportJson = Schema.encodeEffect(Schema.fromJsonString(StudyEvalReport));

function evaluationError(path: string, message: string, cause?: unknown): StudyLoopError {
  return new StudyLoopError({
    operation: "evaluate",
    path,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function eventText(event: StudyTraceEvent): string | null {
  switch (event.type) {
    case "user_message":
    case "assistant_message":
      return event.text;
    case "tool_result":
      return event.output;
    case "interruption":
      return event.detail ?? null;
    case "checkpoint":
      return event.note ?? null;
    default:
      return null;
  }
}

function matchesEvent(record: StudyTraceRecord, matcher: StudyTraceEventMatcher): boolean {
  const event = record.event;
  if (event.type !== matcher.eventType) return false;
  if (
    matcher.toolName !== undefined &&
    !(
      (event.type === "tool_call" || event.type === "tool_result") &&
      event.name === matcher.toolName
    )
  ) {
    return false;
  }
  if (
    matcher.actor !== undefined &&
    (!(event.type === "state_changed") || event.actor !== matcher.actor)
  ) {
    return false;
  }
  if (matcher.textIncludes !== undefined) {
    const text = eventText(event);
    if (
      text === null ||
      !text.toLocaleLowerCase().includes(matcher.textIncludes.toLocaleLowerCase())
    ) {
      return false;
    }
  }
  return true;
}

function matchingIndices(
  records: ReadonlyArray<StudyTraceRecord>,
  matcher: StudyTraceEventMatcher,
): number[] {
  const indices: number[] = [];
  for (const [index, record] of records.entries()) {
    if (matchesEvent(record, matcher)) indices.push(index);
  }
  return indices;
}

function assertionWeight(assertion: StudyEvalAssertion): number {
  return assertion.weight ?? 1;
}

function evaluateAssertion(
  assertion: StudyEvalAssertion,
  assertionIndex: number,
  records: ReadonlyArray<StudyTraceRecord>,
): StudyEvalAssertionResult {
  const weight = assertionWeight(assertion);
  if (assertion.type === "event_count") {
    const count = matchingIndices(records, assertion.matcher).length;
    const passed =
      count >= assertion.min && (assertion.max === undefined || count <= assertion.max);
    const expected =
      assertion.max === undefined
        ? `at least ${assertion.min}`
        : `${assertion.min}..${assertion.max}`;
    return {
      assertionIndex,
      type: assertion.type,
      passed,
      weight,
      detail: `Matched ${count} events; expected ${expected}.`,
    };
  }

  if (assertion.type === "event_order") {
    const before = matchingIndices(records, assertion.before);
    const after = matchingIndices(records, assertion.after);
    const passed = before.some((beforeIndex) =>
      after.some((afterIndex) => afterIndex > beforeIndex),
    );
    return {
      assertionIndex,
      type: assertion.type,
      passed,
      weight,
      detail: passed
        ? "Observed the required event order."
        : `No ordered pair was found (${before.length} before matches, ${after.length} after matches).`,
    };
  }

  const from = matchingIndices(records, assertion.from);
  const to = matchingIndices(records, assertion.to);
  const latencies: number[] = [];
  for (const fromIndex of from) {
    const toIndex = to.find((candidate) => candidate > fromIndex);
    const fromRecord = records[fromIndex];
    const toRecord = toIndex === undefined ? undefined : records[toIndex];
    if (!fromRecord || !toRecord) continue;
    const latency = Date.parse(toRecord.timestamp) - Date.parse(fromRecord.timestamp);
    if (Number.isFinite(latency) && latency >= 0) latencies.push(latency);
  }
  const bestLatency = latencies.length > 0 ? Math.min(...latencies) : null;
  const passed = bestLatency !== null && bestLatency <= assertion.maxMs;
  return {
    assertionIndex,
    type: assertion.type,
    passed,
    weight,
    detail:
      bestLatency === null
        ? "No ordered events with valid timestamps were found."
        : `Best observed latency was ${bestLatency} ms; limit is ${assertion.maxMs} ms.`,
  };
}

function summarizeSplit(
  cases: ReadonlyArray<StudyEvalCaseResult>,
  split: "train" | "holdout",
): StudyEvalSplitSummary {
  const selected = cases.filter((result) => result.split === split);
  const totalWeight = selected.reduce((sum, result) => sum + result.weight, 0);
  const weightedScore = selected.reduce((sum, result) => sum + result.score * result.weight, 0);
  return {
    cases: selected.length,
    passed: selected.filter((result) => result.passed).length,
    score: totalWeight === 0 ? 0 : weightedScore / totalWeight,
  };
}

export const readStudyEvalDatasetFile = Effect.fn("StudyEvalRunner.readDataset")(function* (
  datasetPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(datasetPath)
    .pipe(
      Effect.mapError((cause) =>
        evaluationError(datasetPath, "Could not read the eval dataset.", cause),
      ),
    );
  return yield* decodeDatasetJson(contents).pipe(
    Effect.mapError((cause) =>
      evaluationError(datasetPath, "Eval dataset does not match version 1.", cause),
    ),
  );
});

export const evaluateStudyDataset = Effect.fn("StudyEvalRunner.evaluateDataset")(function* (input: {
  readonly paths: StudyLoopPaths;
  readonly dataset: StudyEvalDataset;
  readonly traceBindings?: Readonly<Record<string, StudyTraceRunId>>;
  readonly reportId?: string;
  readonly evaluatedAt?: string;
}) {
  const evaluatedAt = input.evaluatedAt ?? DateTime.formatIso(yield* DateTime.now);
  const results = yield* Effect.forEach(
    input.dataset.cases,
    (evalCase) =>
      Effect.gen(function* () {
        const traceId = input.traceBindings?.[evalCase.id] ?? evalCase.traceId;
        if (!traceId) {
          return yield* evaluationError(
            evalCase.id,
            "Eval case needs a traceId or a runtime trace binding.",
          );
        }
        const trace = yield* readStudyTrace(input.paths, traceId);
        const start = trace.records[0];
        if (!start || start.event.type !== "run_started") {
          return yield* evaluationError(traceId, "Verified trace has no run_started event.");
        }
        const assertions = evalCase.assertions.map((assertion, assertionIndex) =>
          evaluateAssertion(assertion, assertionIndex, trace.records),
        );
        const totalWeight = assertions.reduce((sum, result) => sum + result.weight, 0);
        const passedWeight = assertions.reduce(
          (sum, result) => sum + (result.passed ? result.weight : 0),
          0,
        );
        return {
          caseId: evalCase.id,
          traceId,
          split: evalCase.split,
          passed: assertions.every((result) => result.passed),
          score: totalWeight === 0 ? 0 : passedWeight / totalWeight,
          weight: evalCase.weight ?? 1,
          assertions,
          skill: start.event.skill,
          runtime: start.event.runtime,
          traceIntegrityHash: trace.integrityHash,
        } satisfies StudyEvalCaseResult;
      }),
    { concurrency: 1 },
  );

  const totalWeight = results.reduce((sum, result) => sum + result.weight, 0);
  const weightedScore = results.reduce((sum, result) => sum + result.score * result.weight, 0);
  return {
    version: 1,
    reportId: input.reportId ?? `eval-${NodeCrypto.randomUUID()}`,
    datasetId: input.dataset.id,
    datasetHash: hashStudyValue(input.dataset),
    grader: { id: "deterministic-trace", version: "1" },
    evaluatedAt,
    score: totalWeight === 0 ? 0 : weightedScore / totalWeight,
    passed: results.every((result) => result.passed),
    splits: {
      train: summarizeSplit(results, "train"),
      holdout: summarizeSplit(results, "holdout"),
    },
    cases: results,
  } satisfies StudyEvalReport;
});

export const writeStudyEvalReport = Effect.fn("StudyEvalRunner.writeReport")(function* (input: {
  readonly paths: StudyLoopPaths;
  readonly report: StudyEvalReport;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reportPath = path.join(input.paths.reports, `${input.report.reportId}.json`);
  const encoded = yield* encodeReportJson(input.report).pipe(
    Effect.mapError((cause) => evaluationError(reportPath, "Could not encode eval report.", cause)),
  );
  yield* fileSystem
    .makeDirectory(input.paths.reports, { recursive: true })
    .pipe(
      Effect.mapError((cause) =>
        evaluationError(reportPath, "Could not create the eval report directory.", cause),
      ),
    );
  yield* writeFileStringAtomically({ filePath: reportPath, contents: `${encoded}\n` }).pipe(
    Effect.mapError((cause) => evaluationError(reportPath, "Could not write eval report.", cause)),
  );
  return reportPath;
});

export const readStudyEvalReportFile = Effect.fn("StudyEvalRunner.readReport")(function* (
  reportPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(reportPath)
    .pipe(
      Effect.mapError((cause) => evaluationError(reportPath, "Could not read eval report.", cause)),
    );
  return yield* decodeReportJson(contents).pipe(
    Effect.mapError((cause) =>
      evaluationError(reportPath, "Eval report does not match version 1.", cause),
    ),
  );
});

export const compareStudyEvalReports = Effect.fn("StudyEvalRunner.compareReports")(
  function* (input: {
    readonly baseline: StudyEvalReport;
    readonly candidate: StudyEvalReport;
    readonly policy: StudyPromotionPolicy;
  }) {
    const comparisonPath = `${input.baseline.reportId}:${input.candidate.reportId}`;
    if (input.baseline.datasetId !== input.candidate.datasetId) {
      return yield* new StudyLoopError({
        operation: "compare",
        path: comparisonPath,
        message: "Cannot compare reports from different datasets.",
      });
    }
    if (input.baseline.datasetHash !== input.candidate.datasetHash) {
      return yield* new StudyLoopError({
        operation: "compare",
        path: comparisonPath,
        message: "Cannot compare reports from different dataset contents.",
      });
    }
    if (
      input.baseline.grader.id !== input.candidate.grader.id ||
      input.baseline.grader.version !== input.candidate.grader.version
    ) {
      return yield* new StudyLoopError({
        operation: "compare",
        path: comparisonPath,
        message: "Cannot compare reports produced by different grader versions.",
      });
    }
    const baselineCases = new Map(input.baseline.cases.map((result) => [result.caseId, result]));
    const candidateCases = new Map(input.candidate.cases.map((result) => [result.caseId, result]));
    const baselineIds = [...baselineCases.keys()].sort();
    const candidateIds = [...candidateCases.keys()].sort();
    if (
      baselineIds.length !== candidateIds.length ||
      baselineIds.some((caseId, index) => candidateIds[index] !== caseId)
    ) {
      return yield* new StudyLoopError({
        operation: "compare",
        path: comparisonPath,
        message: "Cannot compare reports with different eval cases.",
      });
    }

    const improvements: string[] = [];
    const regressions: string[] = [];
    for (const caseId of baselineIds) {
      const baseline = baselineCases.get(caseId);
      const candidate = candidateCases.get(caseId);
      if (!baseline || !candidate) continue;
      if (candidate.score > baseline.score) improvements.push(caseId);
      if (candidate.score < baseline.score) regressions.push(caseId);
    }

    const overallDelta = input.candidate.score - input.baseline.score;
    const trainDelta = input.candidate.splits.train.score - input.baseline.splits.train.score;
    const holdoutDelta = input.candidate.splits.holdout.score - input.baseline.splits.holdout.score;
    const reasons: string[] = [];
    if (input.policy.requireCandidatePass && !input.candidate.passed) {
      reasons.push("Candidate does not pass every eval assertion.");
    }
    if (input.candidate.splits.holdout.cases === 0) {
      reasons.push("Candidate report has no holdout cases.");
    }
    if (overallDelta < input.policy.minimumOverallDelta) {
      reasons.push(
        `Overall delta ${overallDelta.toFixed(4)} is below ${input.policy.minimumOverallDelta.toFixed(4)}.`,
      );
    }
    if (holdoutDelta < input.policy.minimumHoldoutDelta) {
      reasons.push(
        `Holdout delta ${holdoutDelta.toFixed(4)} is below ${input.policy.minimumHoldoutDelta.toFixed(4)}.`,
      );
    }
    if (regressions.length > input.policy.maximumRegressions) {
      reasons.push(
        `${regressions.length} regressions exceed the limit of ${input.policy.maximumRegressions}.`,
      );
    }

    return {
      version: 1,
      datasetId: input.baseline.datasetId,
      datasetHash: input.baseline.datasetHash,
      grader: input.baseline.grader,
      policy: input.policy,
      baselineReportId: input.baseline.reportId,
      candidateReportId: input.candidate.reportId,
      baselineReportHash: hashStudyValue(input.baseline),
      candidateReportHash: hashStudyValue(input.candidate),
      overallDelta,
      trainDelta,
      holdoutDelta,
      improvements,
      regressions,
      promotable: reasons.length === 0,
      reasons,
    } satisfies StudyEvalComparison;
  },
);
