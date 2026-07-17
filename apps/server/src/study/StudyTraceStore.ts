import * as NodeCrypto from "node:crypto";

import {
  StudyLoopError,
  StudyTraceRecord,
  type StudyTraceEvent,
  type StudyTraceRunId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { StudyLibraryPaths } from "./StudyLibrary.ts";

const MAX_TRACE_BYTES = 128 * 1024 * 1024;
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeTraceRecord = Schema.decodeUnknownEffect(StudyTraceRecord);

export interface StudyLoopPaths {
  readonly root: string;
  readonly traces: string;
  readonly reports: string;
}

export interface VerifiedStudyTrace {
  readonly runId: StudyTraceRunId;
  readonly records: ReadonlyArray<StudyTraceRecord>;
  readonly complete: boolean;
  readonly integrityHash: string;
}

export interface StudyTraceSummary {
  readonly runId: StudyTraceRunId;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly complete: boolean;
  readonly events: number;
  readonly skillName: string;
  readonly skillVersion: string;
  readonly skillHash: string;
}

export function canonicalStudyJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Trace values must contain finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStudyJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStudyJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Trace values cannot contain ${typeof value}.`);
}

export function hashStudyValue(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(canonicalStudyJson(value), "utf8").digest("hex");
}

function hashRecordBody(record: Omit<StudyTraceRecord, "hash">): string {
  return hashStudyValue(record);
}

export function buildStudyTraceRecord(input: {
  readonly runId: StudyTraceRunId;
  readonly sequence: number;
  readonly timestamp: string;
  readonly previousHash: string | null;
  readonly event: StudyTraceEvent;
}): StudyTraceRecord {
  const body = {
    version: 1 as const,
    runId: input.runId,
    sequence: input.sequence,
    timestamp: input.timestamp,
    previousHash: input.previousHash,
    event: input.event,
  };
  return {
    ...body,
    hash: hashRecordBody(body),
  };
}

export const resolveStudyLoopPaths = Effect.fn("StudyTraceStore.resolvePaths")(function* (
  libraryPaths: StudyLibraryPaths,
) {
  const path = yield* Path.Path;
  const root = path.join(libraryPaths.root, "loop");
  return {
    root,
    traces: path.join(root, "traces"),
    reports: path.join(root, "reports"),
  } satisfies StudyLoopPaths;
});

export const studyTracePath = Effect.fn("StudyTraceStore.tracePath")(function* (
  paths: StudyLoopPaths,
  runId: StudyTraceRunId,
) {
  const path = yield* Path.Path;
  return path.join(paths.traces, `${runId}.jsonl`);
});

function invalidTrace(path: string, message: string, cause?: unknown): StudyLoopError {
  return new StudyLoopError({
    operation: "read-trace",
    path,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

export const readStudyTraceFile = Effect.fn("StudyTraceStore.readTraceFile")(function* (
  tracePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem
    .stat(tracePath)
    .pipe(
      Effect.mapError((cause) =>
        invalidTrace(tracePath, "Could not inspect the trace file.", cause),
      ),
    );
  if (info.type !== "File" || Number(info.size) > MAX_TRACE_BYTES) {
    return yield* invalidTrace(
      tracePath,
      `Trace must be a file no larger than ${MAX_TRACE_BYTES / 1024 / 1024} MB.`,
    );
  }
  const contents = yield* fileSystem
    .readFileString(tracePath)
    .pipe(
      Effect.mapError((cause) => invalidTrace(tracePath, "Could not read the trace file.", cause)),
    );
  const lines = contents.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return yield* invalidTrace(tracePath, "Trace file is empty.");
  }

  const records: StudyTraceRecord[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const parsed = yield* decodeUnknownJson(line).pipe(
      Effect.mapError((cause) =>
        invalidTrace(tracePath, `Trace line ${lineIndex + 1} is not JSON.`, cause),
      ),
    );
    const record = yield* decodeTraceRecord(parsed).pipe(
      Effect.mapError((cause) =>
        invalidTrace(tracePath, `Trace line ${lineIndex + 1} does not match version 1.`, cause),
      ),
    );
    records.push(record);
  }

  const runId = records[0]?.runId;
  if (!runId || records[0]?.event.type !== "run_started") {
    return yield* invalidTrace(tracePath, "Trace must begin with run_started.");
  }

  let expectedPreviousHash: string | null = null;
  let finished = false;
  for (const [index, record] of records.entries()) {
    if (record.runId !== runId) {
      return yield* invalidTrace(tracePath, `Trace line ${index + 1} changes runId.`);
    }
    if (record.sequence !== index) {
      return yield* invalidTrace(
        tracePath,
        `Trace line ${index + 1} has a non-contiguous sequence.`,
      );
    }
    if (record.previousHash !== expectedPreviousHash) {
      return yield* invalidTrace(tracePath, `Trace line ${index + 1} breaks the hash chain.`);
    }
    const { hash, ...body } = record;
    if (hashRecordBody(body) !== hash) {
      return yield* invalidTrace(tracePath, `Trace line ${index + 1} has an invalid hash.`);
    }
    if (index > 0 && record.event.type === "run_started") {
      return yield* invalidTrace(tracePath, "Trace contains more than one run_started event.");
    }
    if (finished) {
      return yield* invalidTrace(tracePath, "Trace contains events after run_finished.");
    }
    finished = record.event.type === "run_finished";
    expectedPreviousHash = hash;
  }

  return {
    runId,
    records,
    complete: finished,
    integrityHash: expectedPreviousHash ?? "",
  } satisfies VerifiedStudyTrace;
});

export const readStudyTrace = Effect.fn("StudyTraceStore.readTrace")(function* (
  paths: StudyLoopPaths,
  runId: StudyTraceRunId,
) {
  return yield* readStudyTraceFile(yield* studyTracePath(paths, runId));
});

export const writeStudyTraceFile = Effect.fn("StudyTraceStore.writeTraceFile")(function* (input: {
  readonly tracePath: string;
  readonly records: ReadonlyArray<StudyTraceRecord>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = `${input.records.map(canonicalStudyJson).join("\n")}\n`;
  yield* fileSystem.makeDirectory(path.dirname(input.tracePath), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new StudyLoopError({
          operation: "write-trace",
          path: input.tracePath,
          message: "Could not create the trace directory.",
          cause,
        }),
    ),
  );
  const publishResult = yield* Effect.result(
    Effect.scoped(
      Effect.gen(function* () {
        const tempPath = yield* fileSystem.makeTempFileScoped({
          directory: path.dirname(input.tracePath),
          prefix: `.${path.basename(input.tracePath)}.`,
          suffix: ".tmp",
        });
        yield* fileSystem.writeFileString(tempPath, contents);
        yield* fileSystem.link(tempPath, input.tracePath);
      }),
    ),
  );
  if (publishResult._tag === "Success") return;

  if (publishResult.failure.reason._tag === "AlreadyExists") {
    const existingResult = yield* Effect.result(fileSystem.readFileString(input.tracePath));
    if (existingResult._tag === "Success" && existingResult.success === contents) {
      return;
    }
    return yield* new StudyLoopError({
      operation: "write-trace",
      path: input.tracePath,
      message:
        existingResult._tag === "Success"
          ? "Study traces are immutable; this run ID already contains different bytes."
          : "Could not verify the existing immutable trace.",
      cause: existingResult._tag === "Failure" ? existingResult.failure : publishResult.failure,
    });
  }

  return yield* new StudyLoopError({
    operation: "write-trace",
    path: input.tracePath,
    message: "Could not write the trace file.",
    cause: publishResult.failure,
  });
});

export const listStudyTraces = Effect.fn("StudyTraceStore.listTraces")(function* (
  paths: StudyLoopPaths,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fileSystem.exists(paths.traces);
  if (!exists) return [];
  const entries = yield* fileSystem
    .readDirectory(paths.traces)
    .pipe(
      Effect.mapError((cause) => invalidTrace(paths.traces, "Could not list trace files.", cause)),
    );
  const traceFiles = entries.filter((entry) => entry.endsWith(".jsonl")).sort();
  const traceResults = yield* Effect.forEach(
    traceFiles,
    (entry) => Effect.result(readStudyTraceFile(path.join(paths.traces, entry))),
    { concurrency: 1 },
  );
  const traces = traceResults.flatMap((result) =>
    result._tag === "Success" ? [result.success] : [],
  );
  return traces.map((trace) => {
    const started = trace.records[0];
    if (!started || started.event.type !== "run_started") {
      throw new Error("Verified trace has no run_started record.");
    }
    const finished = trace.records.at(-1);
    return {
      runId: trace.runId,
      startedAt: started.timestamp,
      finishedAt: finished?.event.type === "run_finished" ? finished.timestamp : null,
      complete: trace.complete,
      events: trace.records.length,
      skillName: started.event.skill.name,
      skillVersion: started.event.skill.version,
      skillHash: started.event.skill.contentHash,
    } satisfies StudyTraceSummary;
  });
});
