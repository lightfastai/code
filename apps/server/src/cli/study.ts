import { StudyDocument, StudyDocumentId, StudyTraceRunId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { expandHomePath } from "../os-jank.ts";
import {
  importStudyDocument,
  readStudyLibraryIndex,
  resolveStudyLibraryPaths,
  tagStudyDocument,
} from "../study/StudyLibrary.ts";
import {
  compareStudyEvalReports,
  evaluateStudyDataset,
  readStudyEvalDatasetFile,
  readStudyEvalReportFile,
  writeStudyEvalReport,
} from "../study/StudyEvalRunner.ts";
import {
  listStudyTraces,
  readStudyTrace,
  resolveStudyLoopPaths,
} from "../study/StudyTraceStore.ts";
import { extractStudyDocumentText } from "../study/StudyTextExtractor.ts";

const encodeStudyDocuments = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(StudyDocument)),
);
const decodeStudyDocumentId = Schema.decodeUnknownEffect(StudyDocumentId);
const decodeStudyTraceRunId = Schema.decodeUnknownEffect(StudyTraceRunId);
const encodeUnknownJson = Schema.encodeEffect(Schema.UnknownFromJsonString);
const decodeStudyTraceBindings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, StudyTraceRunId)),
);

const studyRootCommand = Command.make("study").pipe(
  Command.withSharedFlags({
    library: Flag.string("library").pipe(
      Flag.withDescription(
        "Canonical local library directory (defaults to T3_STUDY_LIBRARY or ~/.t3/study-library).",
      ),
      Flag.optional,
    ),
  }),
  Command.withDescription("Manage the local-first study library."),
);

const resolvePaths = Effect.fn("StudyCli.resolvePaths")(function* () {
  const shared = yield* studyRootCommand;
  const path = yield* Path.Path;
  const configured =
    Option.getOrUndefined(shared.library) ?? process.env.T3_STUDY_LIBRARY ?? "~/.t3/study-library";
  return yield* resolveStudyLibraryPaths(path.resolve(yield* expandHomePath(configured)));
});

const studyImportCommand = Command.make(
  "import",
  {
    files: Argument.string("files").pipe(
      Argument.withDescription("PDF, EPUB, or Markdown files to import."),
      Argument.variadic({ min: 1 }),
    ),
    tags: Flag.string("tag").pipe(
      Flag.withDescription("Tag to apply; may be repeated."),
      Flag.between(0, 32),
    ),
    metadataOnly: Flag.boolean("metadata-only").pipe(
      Flag.withDescription("Store the original without extracting searchable text."),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("StudyCli.import")(function* ({ files, metadataOnly, tags }) {
    const paths = yield* resolvePaths();
    const documents = yield* Effect.forEach(
      files,
      (sourcePath) => importStudyDocument({ paths, sourcePath, tags }),
      { concurrency: 1 },
    );
    for (const document of documents) {
      const extracted = metadataOnly ? null : yield* extractStudyDocumentText({ paths, document });
      yield* Console.log(
        `Imported ${document.title} [${document.format}] ${document.id.slice(0, 12)}${
          extracted ? ` · ${extracted.segments.length} text segments` : ""
        }`,
      );
    }
    yield* Console.log(`Library: ${paths.root}`);
  }),
).pipe(Command.withDescription("Import immutable, content-addressed study documents."));

const studyListCommand = Command.make(
  "list",
  {
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print machine-readable JSON."),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("StudyCli.list")(function* ({ json }) {
    const paths = yield* resolvePaths();
    const index = yield* readStudyLibraryIndex(paths);
    if (json) {
      yield* Console.log(yield* encodeStudyDocuments(index.documents));
      return;
    }
    if (index.documents.length === 0) {
      yield* Console.log(`No books in ${paths.root}`);
      return;
    }
    for (const document of index.documents) {
      const tags = document.tags.length > 0 ? ` · ${document.tags.join(", ")}` : "";
      yield* Console.log(
        `${document.id.slice(0, 12)}  ${document.format.padEnd(8)}  ${document.title}${tags}`,
      );
    }
  }),
).pipe(
  Command.withDescription("List documents in the local study library."),
  Command.withAlias("ls"),
);

const studyTagCommand = Command.make(
  "tag",
  {
    documentId: Argument.string("document-id").pipe(
      Argument.withDescription("Full SHA-256 study document id."),
    ),
    tags: Flag.string("tag").pipe(
      Flag.withDescription("Tag to add; may be repeated."),
      Flag.between(1, 32),
    ),
  },
  Effect.fn("StudyCli.tag")(function* ({ documentId, tags }) {
    const paths = yield* resolvePaths();
    const decodedId = yield* decodeStudyDocumentId(documentId);
    const document = yield* tagStudyDocument({ paths, documentId: decodedId, tags });
    yield* Console.log(`${document.title}: ${document.tags.join(", ")}`);
  }),
).pipe(Command.withDescription("Add tags to a study document."));

const studyTraceListCommand = Command.make(
  "list",
  {
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print machine-readable JSON."),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("StudyCli.traceList")(function* ({ json }) {
    const loopPaths = yield* resolveStudyLoopPaths(yield* resolvePaths());
    const traces = yield* listStudyTraces(loopPaths);
    if (json) {
      yield* Console.log(yield* encodeUnknownJson(traces));
      return;
    }
    if (traces.length === 0) {
      yield* Console.log(`No study traces in ${loopPaths.traces}`);
      return;
    }
    for (const trace of traces) {
      const status = trace.complete ? "complete" : "incomplete";
      yield* Console.log(
        `${trace.runId}  ${status.padEnd(10)}  ${trace.events.toString().padStart(4)} events  ${trace.skillName}@${trace.skillVersion}`,
      );
    }
  }),
).pipe(Command.withDescription("List locally captured interactive study traces."));

const studyTraceVerifyCommand = Command.make(
  "verify",
  {
    runId: Argument.string("run-id").pipe(Argument.withDescription("Trace run identifier.")),
  },
  Effect.fn("StudyCli.traceVerify")(function* ({ runId }) {
    const decodedRunId = yield* decodeStudyTraceRunId(runId);
    const trace = yield* readStudyTrace(
      yield* resolveStudyLoopPaths(yield* resolvePaths()),
      decodedRunId,
    );
    yield* Console.log(
      `${trace.runId}: ${trace.records.length} events · ${trace.complete ? "complete" : "incomplete"} · sha256 ${trace.integrityHash}`,
    );
  }),
).pipe(Command.withDescription("Verify a trace schema, sequence, and SHA-256 hash chain."));

const studyTraceCommand = Command.make("trace").pipe(
  Command.withDescription("Inspect immutable interactive study traces."),
  Command.withSubcommands([studyTraceListCommand, studyTraceVerifyCommand]),
);

const studyEvalRunCommand = Command.make(
  "run",
  {
    dataset: Argument.string("dataset").pipe(
      Argument.withDescription("Path to a version 1 study eval dataset."),
    ),
    bindings: Flag.string("bindings").pipe(
      Flag.withDescription("JSON map from eval case ID to captured trace run ID."),
      Flag.optional,
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print the complete report as JSON."),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("StudyCli.evalRun")(function* ({ bindings, dataset, json }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const datasetPath = path.resolve(yield* expandHomePath(dataset));
    const loopPaths = yield* resolveStudyLoopPaths(yield* resolvePaths());
    const traceBindings = Option.isSome(bindings)
      ? yield* decodeStudyTraceBindings(
          yield* fileSystem.readFileString(path.resolve(yield* expandHomePath(bindings.value))),
        )
      : undefined;
    const report = yield* evaluateStudyDataset({
      paths: loopPaths,
      dataset: yield* readStudyEvalDatasetFile(datasetPath),
      ...(traceBindings === undefined ? {} : { traceBindings }),
    });
    const reportPath = yield* writeStudyEvalReport({ paths: loopPaths, report });
    if (json) {
      yield* Console.log(yield* encodeUnknownJson(report));
      return;
    }
    yield* Console.log(
      `${report.passed ? "PASS" : "FAIL"} ${(report.score * 100).toFixed(1)}% · train ${(report.splits.train.score * 100).toFixed(1)}% · holdout ${(report.splits.holdout.score * 100).toFixed(1)}%`,
    );
    yield* Console.log(`Report: ${reportPath}`);
  }),
).pipe(
  Command.withDescription("Replay deterministic assertions over captured interaction traces."),
);

const studyEvalCompareCommand = Command.make(
  "compare",
  {
    baseline: Argument.string("baseline").pipe(
      Argument.withDescription("Path to the baseline eval report."),
    ),
    candidate: Argument.string("candidate").pipe(
      Argument.withDescription("Path to the candidate eval report."),
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Print the comparison as JSON."),
      Flag.withDefault(false),
    ),
  },
  Effect.fn("StudyCli.evalCompare")(function* ({ baseline, candidate, json }) {
    const path = yield* Path.Path;
    const comparison = yield* compareStudyEvalReports({
      baseline: yield* readStudyEvalReportFile(path.resolve(yield* expandHomePath(baseline))),
      candidate: yield* readStudyEvalReportFile(path.resolve(yield* expandHomePath(candidate))),
      policy: {
        minimumOverallDelta: 0,
        minimumHoldoutDelta: 0,
        maximumRegressions: 0,
        requireCandidatePass: true,
      },
    });
    if (json) {
      yield* Console.log(yield* encodeUnknownJson(comparison));
      return;
    }
    yield* Console.log(
      `${comparison.promotable ? "PROMOTE" : "REJECT"} · overall ${(comparison.overallDelta * 100).toFixed(1)} pp · holdout ${(comparison.holdoutDelta * 100).toFixed(1)} pp`,
    );
    if (comparison.regressions.length > 0) {
      yield* Console.log(`Regressions: ${comparison.regressions.join(", ")}`);
    }
    for (const reason of comparison.reasons) yield* Console.log(`- ${reason}`);
  }),
).pipe(
  Command.withDescription("Compare baseline and candidate reports using a strict promotion gate."),
);

const studyEvalCommand = Command.make("eval").pipe(
  Command.withDescription("Run and compare offline study-agent evaluations."),
  Command.withSubcommands([studyEvalRunCommand, studyEvalCompareCommand]),
);

export const studyCommand = studyRootCommand.pipe(
  Command.withSubcommands([
    studyImportCommand,
    studyListCommand,
    studyTagCommand,
    studyTraceCommand,
    studyEvalCommand,
  ]),
);
