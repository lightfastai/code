import type { NotebookRevision } from "@t3tools/contracts";

type NotebookCodeCell = Extract<
  NotebookRevision["document"]["cells"][number],
  { cell_type: "code" }
>;
export type NotebookRuntimeOutput = NotebookCodeCell["outputs"][number];

// Runtime output is a disposable view cache. These limits keep the 32-session LRU
// below a predictable memory ceiling without changing immutable notebook revisions.
export const NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_CELL = 128;
export const NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL = 1024 * 1024;
export const NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_SESSION = 512;
export const NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_SESSION = 4 * 1024 * 1024;

export type NotebookOutputRetention = {
  readonly omittedEntries: number;
  readonly omittedBytes: number;
};

export type NotebookOutputState = {
  readonly outputsByCell: ReadonlyMap<string, ReadonlyArray<NotebookRuntimeOutput>>;
  readonly outputKeysByCell: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly outputEntryBytesByCell: ReadonlyMap<string, ReadonlyArray<number>>;
  readonly outputBytesByCell: ReadonlyMap<string, number>;
  readonly outputCellRecency: ReadonlyArray<string>;
  readonly outputRetentionByCell: ReadonlyMap<string, NotebookOutputRetention>;
};

const utf8Encoder = new TextEncoder();

const serializedOutputBytes = (output: NotebookRuntimeOutput): number =>
  utf8Encoder.encode(JSON.stringify(output)).byteLength;

const touchCell = (recency: ReadonlyArray<string>, cellId: string): string[] => [
  ...recency.filter((candidate) => candidate !== cellId),
  cellId,
];

const addOmission = (
  retentionByCell: Map<string, NotebookOutputRetention>,
  cellId: string,
  omittedEntries: number,
  omittedBytes: number,
): void => {
  if (omittedEntries <= 0 && omittedBytes <= 0) return;
  const current = retentionByCell.get(cellId) ?? { omittedEntries: 0, omittedBytes: 0 };
  retentionByCell.set(cellId, {
    omittedEntries: current.omittedEntries + omittedEntries,
    omittedBytes: current.omittedBytes + omittedBytes,
  });
};

const fitStreamOutput = (
  output: Extract<NotebookRuntimeOutput, { output_type: "stream" }>,
): {
  readonly output: NotebookRuntimeOutput;
  readonly bytes: number;
  readonly omittedBytes: number;
} => {
  const originalBytes = serializedOutputBytes(output);
  if (originalBytes <= NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL) {
    return { output, bytes: originalBytes, omittedBytes: 0 };
  }

  let low = 0;
  let high = output.text.length;
  let fitted = { ...output, text: "" };
  let fittedBytes = serializedOutputBytes(fitted);
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const candidate = { ...output, text: output.text.slice(-midpoint) };
    const candidateBytes = serializedOutputBytes(candidate);
    if (candidateBytes <= NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL) {
      low = midpoint;
      fitted = candidate;
      fittedBytes = candidateBytes;
    } else {
      high = midpoint - 1;
    }
  }
  return {
    output: fitted,
    bytes: fittedBytes,
    omittedBytes: Math.max(0, originalBytes - fittedBytes),
  };
};

export const createNotebookOutputState = (): NotebookOutputState => ({
  outputsByCell: new Map(),
  outputKeysByCell: new Map(),
  outputEntryBytesByCell: new Map(),
  outputBytesByCell: new Map(),
  outputCellRecency: [],
  outputRetentionByCell: new Map(),
});

export const pruneNotebookOutputCell = (
  state: NotebookOutputState,
  cellId: string,
): NotebookOutputState => {
  const outputsByCell = new Map(state.outputsByCell);
  const outputKeysByCell = new Map(state.outputKeysByCell);
  const outputEntryBytesByCell = new Map(state.outputEntryBytesByCell);
  const outputBytesByCell = new Map(state.outputBytesByCell);
  const outputRetentionByCell = new Map(state.outputRetentionByCell);
  outputsByCell.delete(cellId);
  outputKeysByCell.delete(cellId);
  outputEntryBytesByCell.delete(cellId);
  outputBytesByCell.delete(cellId);
  outputRetentionByCell.delete(cellId);
  return {
    outputsByCell,
    outputKeysByCell,
    outputEntryBytesByCell,
    outputBytesByCell,
    outputCellRecency: state.outputCellRecency.filter((candidate) => candidate !== cellId),
    outputRetentionByCell,
  };
};

export const resetNotebookCellOutputs = (
  state: NotebookOutputState,
  cellId: string,
): NotebookOutputState => {
  const outputsByCell = new Map(state.outputsByCell);
  outputsByCell.set(cellId, []);
  const outputKeysByCell = new Map(state.outputKeysByCell);
  outputKeysByCell.set(cellId, []);
  const outputEntryBytesByCell = new Map(state.outputEntryBytesByCell);
  outputEntryBytesByCell.set(cellId, []);
  const outputBytesByCell = new Map(state.outputBytesByCell);
  outputBytesByCell.set(cellId, 0);
  const outputRetentionByCell = new Map(state.outputRetentionByCell);
  outputRetentionByCell.delete(cellId);
  return {
    outputsByCell,
    outputKeysByCell,
    outputEntryBytesByCell,
    outputBytesByCell,
    outputCellRecency: touchCell(state.outputCellRecency, cellId),
    outputRetentionByCell,
  };
};

export const appendNotebookCellOutput = (
  state: NotebookOutputState,
  cellId: string,
  output: NotebookRuntimeOutput,
  outputKey: string,
): NotebookOutputState => {
  const outputsByCell = new Map(state.outputsByCell);
  const outputKeysByCell = new Map(state.outputKeysByCell);
  const outputEntryBytesByCell = new Map(state.outputEntryBytesByCell);
  const outputBytesByCell = new Map(state.outputBytesByCell);
  const outputRetentionByCell = new Map(state.outputRetentionByCell);
  const outputs = [...(outputsByCell.get(cellId) ?? [])];
  const keys = [...(outputKeysByCell.get(cellId) ?? [])];
  const entryBytes = [...(outputEntryBytesByCell.get(cellId) ?? [])];
  const previous = outputs.at(-1);
  const mergeStream =
    output.output_type === "stream" &&
    previous?.output_type === "stream" &&
    previous.name === output.name;
  const candidate = mergeStream ? { ...previous, text: previous.text + output.text } : output;
  const candidateBytes = serializedOutputBytes(candidate);

  if (candidate.output_type === "stream") {
    const fitted = fitStreamOutput(candidate);
    addOmission(outputRetentionByCell, cellId, 0, fitted.omittedBytes);
    if (mergeStream) {
      outputs[outputs.length - 1] = fitted.output;
      entryBytes[entryBytes.length - 1] = fitted.bytes;
    } else {
      outputs.push(fitted.output);
      keys.push(outputKey);
      entryBytes.push(fitted.bytes);
    }
  } else if (candidateBytes <= NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL) {
    outputs.push(candidate);
    keys.push(outputKey);
    entryBytes.push(candidateBytes);
  } else {
    addOmission(outputRetentionByCell, cellId, 1, candidateBytes);
  }

  let cellBytes = entryBytes.reduce((total, bytes) => total + bytes, 0);
  while (
    outputs.length > NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_CELL ||
    cellBytes > NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_CELL
  ) {
    outputs.shift();
    keys.shift();
    const removedBytes = entryBytes.shift() ?? 0;
    cellBytes -= removedBytes;
    addOmission(outputRetentionByCell, cellId, 1, removedBytes);
  }
  outputsByCell.set(cellId, outputs);
  outputKeysByCell.set(cellId, keys);
  outputEntryBytesByCell.set(cellId, entryBytes);
  outputBytesByCell.set(cellId, cellBytes);

  const outputCellRecency = touchCell(state.outputCellRecency, cellId);
  let sessionEntries = [...outputsByCell.values()].reduce(
    (total, retained) => total + retained.length,
    0,
  );
  let sessionBytes = [...outputBytesByCell.values()].reduce(
    (total, retained) => total + retained,
    0,
  );
  while (
    sessionEntries > NOTEBOOK_RUNTIME_OUTPUT_MAX_ENTRIES_PER_SESSION ||
    sessionBytes > NOTEBOOK_RUNTIME_OUTPUT_MAX_BYTES_PER_SESSION
  ) {
    const victimCellId = outputCellRecency.find(
      (candidateCellId) => (outputsByCell.get(candidateCellId)?.length ?? 0) > 0,
    );
    if (victimCellId === undefined) break;
    const victimOutputs = [...(outputsByCell.get(victimCellId) ?? [])];
    const victimKeys = [...(outputKeysByCell.get(victimCellId) ?? [])];
    const victimEntryBytes = [...(outputEntryBytesByCell.get(victimCellId) ?? [])];
    victimOutputs.shift();
    victimKeys.shift();
    const removedBytes = victimEntryBytes.shift() ?? 0;
    const victimBytes = (outputBytesByCell.get(victimCellId) ?? 0) - removedBytes;
    outputsByCell.set(victimCellId, victimOutputs);
    outputKeysByCell.set(victimCellId, victimKeys);
    outputEntryBytesByCell.set(victimCellId, victimEntryBytes);
    outputBytesByCell.set(victimCellId, victimBytes);
    addOmission(outputRetentionByCell, victimCellId, 1, removedBytes);
    sessionEntries -= 1;
    sessionBytes -= removedBytes;
  }

  return {
    outputsByCell,
    outputKeysByCell,
    outputEntryBytesByCell,
    outputBytesByCell,
    outputCellRecency,
    outputRetentionByCell,
  };
};
