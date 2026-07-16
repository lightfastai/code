import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  NOTEBOOK_CELL_SOURCE_MAX_BYTES,
  NOTEBOOK_DOCUMENT_MAX_BYTES,
  NOTEBOOK_MAX_CELLS,
  NOTEBOOK_MAX_OUTPUTS_PER_CELL,
  NOTEBOOK_NBFORMAT_MAJOR,
  NOTEBOOK_NBFORMAT_MINOR,
  NOTEBOOK_OUTPUT_MAX_BYTES,
  NotebookContentHash,
  type NotebookDocument,
  type NotebookCell,
  type NotebookCellMetadata,
  type NotebookKernel,
  type NotebookMimeBundle,
  type NotebookOutput,
  NotebookRevisionError,
} from "./contracts.ts";

const decodeJsonString = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const isNotebookRevisionError = (value: unknown): value is NotebookRevisionError =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "NotebookRevisionError";
const utf8Encoder = new TextEncoder();

type UnknownRecord = Record<string, unknown>;

const invalidNotebook = (message: string) =>
  new NotebookRevisionError({ reason: "invalid-notebook", message });

const limitExceeded = (message: string) =>
  new NotebookRevisionError({ reason: "limit-exceeded", message });

const asRecord = (input: unknown, context: string): UnknownRecord | NotebookRevisionError =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as UnknownRecord)
    : invalidNotebook(`${context} must be an object.`);

const asString = (input: unknown, context: string): string | NotebookRevisionError =>
  typeof input === "string" ? input : invalidNotebook(`${context} must be a string.`);

const sourceString = (input: unknown, context: string): string | NotebookRevisionError => {
  let source: string;
  if (typeof input === "string") {
    source = input;
  } else if (Array.isArray(input) && input.every((part) => typeof part === "string")) {
    source = input.join("");
  } else {
    return invalidNotebook(`${context} must be a string or an array of strings.`);
  }
  if (utf8Encoder.encode(source).byteLength > NOTEBOOK_CELL_SOURCE_MAX_BYTES) {
    return limitExceeded(
      `${context} exceeds the ${NOTEBOOK_CELL_SOURCE_MAX_BYTES} byte source limit.`,
    );
  }
  return source;
};

const textValue = (input: unknown, context: string): string | NotebookRevisionError => {
  if (typeof input === "string") return input;
  if (Array.isArray(input) && input.every((part) => typeof part === "string")) {
    return input.join("");
  }
  return invalidNotebook(`${context} must be a string or an array of strings.`);
};

const optionalBoolean = (input: unknown): boolean | undefined =>
  typeof input === "boolean" ? input : undefined;

const normalizeCellMetadata = (input: unknown): NotebookCellMetadata | NotebookRevisionError => {
  const record = asRecord(input ?? {}, "Cell metadata");
  if (isNotebookRevisionError(record)) return record;
  const metadata: {
    collapsed?: boolean;
    scrolled?: boolean | "auto";
    tags?: string[];
    jupyter?: { sourceHidden?: boolean; outputsHidden?: boolean };
    lightfast?: { locked?: boolean; role?: string };
  } = {};
  const collapsed = optionalBoolean(record.collapsed);
  if (collapsed !== undefined) metadata.collapsed = collapsed;
  if (typeof record.scrolled === "boolean" || record.scrolled === "auto") {
    metadata.scrolled = record.scrolled;
  }
  if (Array.isArray(record.tags)) {
    if (
      record.tags.length > 64 ||
      !record.tags.every((tag) => typeof tag === "string" && tag.length > 0 && tag.length <= 255)
    ) {
      return invalidNotebook("Cell metadata tags are invalid.");
    }
    metadata.tags = Array.from(new Set(record.tags));
  }
  const jupyter = asRecord(record.jupyter ?? {}, "Cell jupyter metadata");
  if (isNotebookRevisionError(jupyter)) return jupyter;
  const sourceHidden = optionalBoolean(jupyter.source_hidden ?? jupyter.sourceHidden);
  const outputsHidden = optionalBoolean(jupyter.outputs_hidden ?? jupyter.outputsHidden);
  if (sourceHidden !== undefined || outputsHidden !== undefined) {
    metadata.jupyter = {
      ...(sourceHidden === undefined ? {} : { sourceHidden }),
      ...(outputsHidden === undefined ? {} : { outputsHidden }),
    };
  }
  const lightfast = asRecord(record.lightfast ?? {}, "Cell lightfast metadata");
  if (isNotebookRevisionError(lightfast)) return lightfast;
  const locked = optionalBoolean(lightfast.locked);
  const role = typeof lightfast.role === "string" ? lightfast.role : undefined;
  if (role !== undefined && (role.length === 0 || role.length > 255)) {
    return invalidNotebook("Cell lightfast metadata role is invalid.");
  }
  if (locked !== undefined || role !== undefined) {
    metadata.lightfast = {
      ...(locked === undefined ? {} : { locked }),
      ...(role === undefined ? {} : { role }),
    };
  }
  return metadata;
};

const JSON_MIME_TYPES = [
  "application/json",
  "application/vnd.dataresource+json",
  "application/vnd.plotly.v1+json",
  "application/vnd.vega.v5+json",
  "application/vnd.vegalite.v5+json",
] as const;
const TEXT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/html",
  "image/png",
  "image/svg+xml",
] as const;

const normalizeMimeBundle = Effect.fn("Notebook.normalizeMimeBundle")(function* (input: unknown) {
  const record = asRecord(input, "Notebook output data");
  if (isNotebookRevisionError(record)) return yield* record;
  const bundle: Record<string, Schema.Json> = {};
  for (const mime of TEXT_MIME_TYPES) {
    if (record[mime] === undefined) continue;
    const value = textValue(record[mime], `Notebook MIME value ${mime}`);
    if (isNotebookRevisionError(value)) return yield* value;
    bundle[mime] = value;
  }
  for (const mime of JSON_MIME_TYPES) {
    if (record[mime] === undefined) continue;
    bundle[mime] = yield* decodeJson(record[mime]).pipe(
      Effect.mapError(() => invalidNotebook(`Notebook MIME value ${mime} must be JSON.`)),
    );
  }
  return bundle as NotebookMimeBundle;
});

const normalizeExecutionCount = (
  input: unknown,
  context: string,
): number | null | NotebookRevisionError =>
  input === null || input === undefined
    ? null
    : Number.isInteger(input) && typeof input === "number" && input >= 0
      ? input
      : invalidNotebook(`${context} must be a non-negative integer or null.`);

const ensureOutputSize = (output: NotebookOutput): NotebookOutput | NotebookRevisionError =>
  utf8Encoder.encode(JSON.stringify(output)).byteLength <= NOTEBOOK_OUTPUT_MAX_BYTES
    ? output
    : limitExceeded(`Notebook output exceeds the ${NOTEBOOK_OUTPUT_MAX_BYTES} byte limit.`);

const normalizeOutput = Effect.fn("Notebook.normalizeOutput")(function* (
  input: unknown,
): Effect.fn.Return<NotebookOutput, NotebookRevisionError> {
  const record = asRecord(input, "Notebook output");
  if (isNotebookRevisionError(record)) return yield* record;
  switch (record.output_type) {
    case "stream": {
      if (record.name !== "stdout" && record.name !== "stderr") {
        return yield* invalidNotebook("Notebook stream name must be stdout or stderr.");
      }
      const text = textValue(record.text, "Notebook stream text");
      if (isNotebookRevisionError(text)) return yield* text;
      const output = ensureOutputSize({ output_type: "stream", name: record.name, text });
      return isNotebookRevisionError(output) ? yield* output : output;
    }
    case "display_data": {
      const output = ensureOutputSize({
        output_type: "display_data",
        data: yield* normalizeMimeBundle(record.data),
        metadata: {},
      });
      return isNotebookRevisionError(output) ? yield* output : output;
    }
    case "execute_result": {
      const executionCount = normalizeExecutionCount(
        record.execution_count,
        "Notebook execution result count",
      );
      if (isNotebookRevisionError(executionCount)) return yield* executionCount;
      const output = ensureOutputSize({
        output_type: "execute_result",
        execution_count: executionCount,
        data: yield* normalizeMimeBundle(record.data),
        metadata: {},
      });
      return isNotebookRevisionError(output) ? yield* output : output;
    }
    case "error": {
      const ename = asString(record.ename, "Notebook error name");
      if (isNotebookRevisionError(ename)) return yield* ename;
      const evalue = asString(record.evalue, "Notebook error value");
      if (isNotebookRevisionError(evalue)) return yield* evalue;
      if (
        !Array.isArray(record.traceback) ||
        record.traceback.length > 1_000 ||
        !record.traceback.every((line) => typeof line === "string")
      ) {
        return yield* invalidNotebook("Notebook error traceback must be an array of strings.");
      }
      const output = ensureOutputSize({
        output_type: "error",
        ename,
        evalue,
        traceback: record.traceback,
      });
      return isNotebookRevisionError(output) ? yield* output : output;
    }
    default:
      return yield* invalidNotebook("Notebook output type is unsupported.");
  }
});

const isCellId = (input: unknown): input is string =>
  typeof input === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(input);

const uniqueCellId = (requested: unknown, index: number, used: Set<string>): string => {
  const base = isCellId(requested) ? requested : `cell-${index + 1}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base.slice(0, 60)}-${suffix}`)) suffix += 1;
  const id = `${base.slice(0, 60)}-${suffix}`;
  used.add(id);
  return id;
};

const normalizeCell = Effect.fn("Notebook.normalizeCell")(function* (
  input: unknown,
  index: number,
  usedIds: Set<string>,
): Effect.fn.Return<NotebookCell, NotebookRevisionError> {
  const record = asRecord(input, `Notebook cell ${index}`);
  if (isNotebookRevisionError(record)) return yield* record;
  const id = uniqueCellId(record.id, index, usedIds);
  const metadata = normalizeCellMetadata(record.metadata);
  if (isNotebookRevisionError(metadata)) return yield* metadata;
  const source = sourceString(record.source, `Notebook cell ${id} source`);
  if (isNotebookRevisionError(source)) return yield* source;
  if (record.cell_type === "markdown") {
    return { cell_type: "markdown", id, metadata, source };
  }
  if (record.cell_type !== "code") {
    return yield* invalidNotebook(`Notebook cell ${id} type is unsupported.`);
  }
  const executionCount = normalizeExecutionCount(
    record.execution_count,
    `Notebook cell ${id} count`,
  );
  if (isNotebookRevisionError(executionCount)) return yield* executionCount;
  if (!Array.isArray(record.outputs)) {
    return yield* invalidNotebook(`Notebook cell ${id} outputs must be an array.`);
  }
  if (record.outputs.length > NOTEBOOK_MAX_OUTPUTS_PER_CELL) {
    return yield* limitExceeded(
      `Notebook cell ${id} exceeds the ${NOTEBOOK_MAX_OUTPUTS_PER_CELL} output limit.`,
    );
  }
  const outputs = yield* Effect.forEach(record.outputs, normalizeOutput);
  return {
    cell_type: "code",
    id,
    metadata,
    source,
    execution_count: executionCount,
    outputs,
  };
});

const normalizeKernel = (metadata: UnknownRecord): NotebookKernel | NotebookRevisionError => {
  const kernel = asRecord(metadata.kernelspec ?? {}, "Notebook kernelspec metadata");
  if (isNotebookRevisionError(kernel)) return kernel;
  const languageInfo = asRecord(metadata.language_info ?? {}, "Notebook language metadata");
  if (isNotebookRevisionError(languageInfo)) return languageInfo;
  const name = typeof kernel.name === "string" ? kernel.name : "python3";
  const displayName = typeof kernel.display_name === "string" ? kernel.display_name : "Python 3";
  const language =
    typeof kernel.language === "string"
      ? kernel.language
      : typeof languageInfo.name === "string"
        ? languageInfo.name
        : "python";
  if (
    name.length === 0 ||
    name.length > 255 ||
    displayName.length === 0 ||
    displayName.length > 255 ||
    language.length === 0 ||
    language.length > 255
  ) {
    return invalidNotebook("Notebook kernelspec metadata is invalid.");
  }
  return { name, displayName, language };
};

export const notebookKernel = (document: NotebookDocument): NotebookKernel => ({
  name: document.metadata.kernelspec.name,
  displayName: document.metadata.kernelspec.display_name,
  language: document.metadata.kernelspec.language,
});

export const normalizeIpynb = Effect.fn("Notebook.normalizeIpynb")(function* (
  input: unknown,
): Effect.fn.Return<NotebookDocument, NotebookRevisionError> {
  const decoded =
    typeof input === "string"
      ? yield* decodeJsonString(input).pipe(
          Effect.mapError(() => invalidNotebook("Notebook JSON could not be parsed.")),
        )
      : input;
  const record = asRecord(decoded, "Notebook");
  if (isNotebookRevisionError(record)) return yield* record;
  if (record.nbformat !== NOTEBOOK_NBFORMAT_MAJOR) {
    return yield* invalidNotebook(`Only nbformat ${NOTEBOOK_NBFORMAT_MAJOR} is supported.`);
  }
  if (!Array.isArray(record.cells)) {
    return yield* invalidNotebook("Notebook cells must be an array.");
  }
  if (record.cells.length > NOTEBOOK_MAX_CELLS) {
    return yield* limitExceeded(`Notebook exceeds the ${NOTEBOOK_MAX_CELLS} cell limit.`);
  }
  const metadata = asRecord(record.metadata ?? {}, "Notebook metadata");
  if (isNotebookRevisionError(metadata)) return yield* metadata;
  const kernel = normalizeKernel(metadata);
  if (isNotebookRevisionError(kernel)) return yield* kernel;
  const lightfastRecord = asRecord(metadata.lightfast ?? {}, "Notebook lightfast metadata");
  if (isNotebookRevisionError(lightfastRecord)) return yield* lightfastRecord;
  const lightfast: { title?: string; sourceDocumentId?: string } = {};
  if (typeof lightfastRecord.title === "string") {
    if (lightfastRecord.title.length === 0 || lightfastRecord.title.length > 255) {
      return yield* invalidNotebook("Notebook lightfast title is invalid.");
    }
    lightfast.title = lightfastRecord.title;
  }
  if (
    typeof lightfastRecord.sourceDocumentId === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(lightfastRecord.sourceDocumentId)
  ) {
    lightfast.sourceDocumentId = lightfastRecord.sourceDocumentId;
  }
  const usedIds = new Set<string>();
  const cells = yield* Effect.forEach(record.cells, (cell, index) =>
    normalizeCell(cell, index, usedIds),
  );
  const document: NotebookDocument = {
    nbformat: NOTEBOOK_NBFORMAT_MAJOR,
    nbformat_minor:
      typeof record.nbformat_minor === "number" &&
      Number.isInteger(record.nbformat_minor) &&
      record.nbformat_minor >= 0
        ? record.nbformat_minor
        : NOTEBOOK_NBFORMAT_MINOR,
    metadata: {
      kernelspec: {
        name: kernel.name,
        display_name: kernel.displayName,
        language: kernel.language,
      },
      ...(Object.keys(lightfast).length === 0 ? {} : { lightfast }),
    },
    cells,
  };
  if (
    utf8Encoder.encode(canonicalNotebookJson(document)).byteLength > NOTEBOOK_DOCUMENT_MAX_BYTES
  ) {
    return yield* limitExceeded(
      `Notebook exceeds the ${NOTEBOOK_DOCUMENT_MAX_BYTES} byte document limit.`,
    );
  }
  return document;
});

const canonicalValue = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  const object = value as Readonly<Record<string, Schema.Json>>;
  const sorted: Record<string, Schema.Json> = {};
  for (const key of Object.keys(object).sort()) {
    const child = object[key];
    if (child !== undefined) sorted[key] = canonicalValue(child);
  }
  return sorted;
};

export const canonicalNotebookJson = (document: NotebookDocument): string =>
  JSON.stringify(canonicalValue(document as Schema.Json));

export const hashNotebook = Effect.fn("Notebook.hashNotebook")(function* (
  document: NotebookDocument,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", utf8Encoder.encode(canonicalNotebookJson(document)))
    .pipe(
      Effect.mapError(
        () => new NotebookRevisionError({ reason: "hash-failed", message: "SHA-256 failed." }),
      ),
    );
  return NotebookContentHash.make(
    Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
});
