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
      const fits =
        selectedOutputs.length < NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_CELL &&
        retainedBytes + bytes <= NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_CELL &&
        sessionEntries + 1 <= NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_SESSION &&
        sessionBytes + bytes <= NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_SESSION;
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
