import type { NotebookOutput } from "./contracts.ts";

// DOM budgets are deliberately lower than the client retention budgets. Notebook
// source/revision data stays intact while only a bounded window is mounted.
export const NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_CELL = 32;
export const NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_CELL = 256 * 1024;
export const NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_SESSION = 256;
export const NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_SESSION = 2 * 1024 * 1024;
export const NOTEBOOK_OUTPUT_RENDER_MAX_CHARACTERS = 100_000;
export const NOTEBOOK_OUTPUT_RENDER_MAX_LINES = 2_000;
export const NOTEBOOK_TABLE_RENDER_MAX_COLUMNS = 50;
export const NOTEBOOK_TABLE_RENDER_MAX_ROWS = 200;
export const NOTEBOOK_TABLE_RENDER_MAX_CELLS = 2_000;
export const NOTEBOOK_TABLE_RENDER_MAX_CELLS_PER_SESSION = 8_000;

type NotebookTableRow = Readonly<Record<string, unknown>>;

export type NotebookTableRenderPlan = {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<NotebookTableRow>;
  readonly renderedCellCount: number;
  readonly truncated: boolean;
};

const isRecord = (value: unknown): value is NotebookTableRow =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const planNotebookTableRendering = (value: unknown): NotebookTableRenderPlan | null => {
  if (!isRecord(value) || !Array.isArray(value.data) || !value.data.every(isRecord)) return null;

  let allColumns: string[];
  if (value.schema !== undefined) {
    if (!isRecord(value.schema) || !Array.isArray(value.schema.fields)) return null;
    const declaredColumns: string[] = [];
    const seenColumns = new Set<string>();
    for (const field of value.schema.fields) {
      if (!isRecord(field) || typeof field.name !== "string" || field.name.length === 0)
        return null;
      if (!seenColumns.has(field.name)) {
        seenColumns.add(field.name);
        declaredColumns.push(field.name);
      }
    }
    allColumns = declaredColumns;
  } else {
    const discovered = new Set<string>();
    for (const row of value.data) {
      for (const key of Object.keys(row)) discovered.add(key);
    }
    allColumns = [...discovered];
  }

  const columns = allColumns.slice(0, NOTEBOOK_TABLE_RENDER_MAX_COLUMNS);
  const productRowLimit =
    columns.length === 0 ? 0 : Math.floor(NOTEBOOK_TABLE_RENDER_MAX_CELLS / columns.length);
  const rowLimit = Math.min(NOTEBOOK_TABLE_RENDER_MAX_ROWS, productRowLimit);
  const rows = value.data.slice(0, rowLimit);
  return {
    columns,
    rows,
    renderedCellCount: columns.length * (rows.length + 1),
    truncated: allColumns.length > columns.length || value.data.length > rows.length,
  };
};

export type NotebookOutputRetentionNotice = {
  readonly omittedEntries: number;
  readonly omittedBytes: number;
};

export type NotebookOutputRenderInput = {
  readonly cellId: string;
  readonly outputs: ReadonlyArray<NotebookOutput>;
  readonly outputKeys?: ReadonlyArray<string> | undefined;
  readonly retention?: NotebookOutputRetentionNotice | undefined;
};

export type NotebookOutputRenderPlan = {
  readonly outputs: ReadonlyArray<NotebookOutput>;
  readonly outputKeys: ReadonlyArray<string>;
  readonly retainedBytes: number;
  readonly retention: NotebookOutputRetentionNotice | null;
};

const utf8Encoder = new TextEncoder();

const serializedOutputBytes = (output: NotebookOutput): number =>
  utf8Encoder.encode(JSON.stringify(output)).byteLength;

const renderedTableCellCount = (output: NotebookOutput): number => {
  if (output.output_type !== "display_data" && output.output_type !== "execute_result") return 0;
  const value = output.data["application/vnd.dataresource+json"];
  if (value === undefined) return 0;
  return planNotebookTableRendering(value)?.renderedCellCount ?? 0;
};

export const notebookOutputKey = (cellId: string, outputIndex: number): string =>
  `${cellId}-output-${outputIndex}`;

export const boundedNotebookText = (
  text: string,
  maxCharacters: number,
  maxLines: number,
): { readonly text: string; readonly truncated: boolean } => {
  let end = Math.min(text.length, maxCharacters);
  let lineEnd = 0;
  for (let line = 0; line < maxLines; line += 1) {
    const newline = text.indexOf("\n", lineEnd);
    if (newline < 0) {
      lineEnd = text.length;
      break;
    }
    lineEnd = newline + 1;
  }
  end = Math.min(end, lineEnd);
  return { text: text.slice(0, end), truncated: end < text.length };
};

export const planNotebookOutputRendering = (
  inputs: ReadonlyArray<NotebookOutputRenderInput>,
): ReadonlyMap<string, NotebookOutputRenderPlan> => {
  const plan = new Map<string, NotebookOutputRenderPlan>();
  let sessionEntries = 0;
  let sessionBytes = 0;
  let sessionTableCells = 0;

  for (const input of inputs) {
    const selectedOutputs: NotebookOutput[] = [];
    const selectedKeys: string[] = [];
    let retainedBytes = 0;
    let omittedEntries = input.retention?.omittedEntries ?? 0;
    let omittedBytes = input.retention?.omittedBytes ?? 0;

    for (let index = input.outputs.length - 1; index >= 0; index -= 1) {
      const output = input.outputs[index];
      if (output === undefined) continue;
      const bytes = serializedOutputBytes(output);
      const tableCells = renderedTableCellCount(output);
      const fits =
        selectedOutputs.length < NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_CELL &&
        retainedBytes + bytes <= NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_CELL &&
        sessionEntries + 1 <= NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_SESSION &&
        sessionBytes + bytes <= NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_SESSION &&
        sessionTableCells + tableCells <= NOTEBOOK_TABLE_RENDER_MAX_CELLS_PER_SESSION;
      if (!fits) {
        omittedEntries += 1;
        omittedBytes += bytes;
        continue;
      }
      selectedOutputs.unshift(output);
      selectedKeys.unshift(input.outputKeys?.[index] ?? notebookOutputKey(input.cellId, index));
      retainedBytes += bytes;
      sessionEntries += 1;
      sessionBytes += bytes;
      sessionTableCells += tableCells;
    }

    plan.set(input.cellId, {
      outputs: selectedOutputs,
      outputKeys: selectedKeys,
      retainedBytes,
      retention: omittedEntries > 0 || omittedBytes > 0 ? { omittedEntries, omittedBytes } : null,
    });
  }
  return plan;
};
