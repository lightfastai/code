import type {
  NotebookOutput,
  NotebookRevision,
} from "@t3tools/lightfast-artifact-notebook/contracts";
import {
  boundedNotebookText,
  planNotebookTableRendering,
  sanitizeNotebookSvg,
} from "@t3tools/lightfast-artifact-notebook/mobile";

export type NotebookMobileLoadState = {
  readonly status: "loading" | "error" | "ready";
  readonly revision: NotebookRevision | null;
  readonly error: string | null;
};

export const beginNotebookMobileLoad = (
  revision: NotebookRevision | null,
): NotebookMobileLoadState => ({ status: "loading", revision, error: null });

export const failNotebookMobileLoad = (
  state: NotebookMobileLoadState,
  error: string,
): NotebookMobileLoadState => ({ status: "error", revision: state.revision, error });

export const completeNotebookMobileLoad = (
  _state: NotebookMobileLoadState,
  revision: NotebookRevision,
): NotebookMobileLoadState => ({ status: "ready", revision, error: null });

type ConnectionPhase =
  | "available"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "error";

export function notebookConnectionPresentation(
  phase: ConnectionPhase,
  hasCachedRevision: boolean,
): { readonly label: string; readonly mutationsDisabled: boolean } {
  if (phase === "connected") {
    return { label: "Paired Mac connected", mutationsDisabled: false };
  }
  const suffix = hasCachedRevision ? " · showing cached notebook" : "";
  switch (phase) {
    case "reconnecting":
      return { label: `Reconnecting to paired Mac${suffix}`, mutationsDisabled: true };
    case "offline":
      return { label: `Paired Mac offline${suffix}`, mutationsDisabled: true };
    case "error":
      return { label: `Paired Mac connection failed${suffix}`, mutationsDisabled: true };
    default:
      return { label: `Connecting to paired Mac${suffix}`, mutationsDisabled: true };
  }
}

export function notebookControlAvailability(
  phase: ConnectionPhase,
  actionPending: boolean,
  runningCellCount: number,
): {
  readonly runDisabled: boolean;
  readonly interruptDisabled: boolean;
  readonly restartDisabled: boolean;
  readonly saveDisabled: boolean;
} {
  const unavailable = phase !== "connected" || actionPending;
  return {
    runDisabled: unavailable || runningCellCount > 0,
    interruptDisabled: unavailable || runningCellCount === 0,
    restartDisabled: unavailable,
    saveDisabled: unavailable,
  };
}

export type NotebookMobileOutputPresentation =
  | { readonly kind: "text"; readonly text: string; readonly tone: "normal" | "error" }
  | { readonly kind: "json"; readonly text: string }
  | {
      readonly kind: "table";
      readonly columns: ReadonlyArray<string>;
      readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
      readonly truncated: boolean;
    }
  | { readonly kind: "image"; readonly mediaType: "image/png"; readonly uri: string }
  | { readonly kind: "svg"; readonly source: string }
  | { readonly kind: "unsupported"; readonly label: string };

const boundedText = (value: string) => boundedNotebookText(value, 100_000, 2_000).text;

function presentMimeBundle(
  data: Readonly<Record<string, unknown>>,
): NotebookMobileOutputPresentation {
  const table = planNotebookTableRendering(data["application/vnd.dataresource+json"]);
  if (table !== null) {
    return {
      kind: "table",
      columns: table.columns,
      rows: table.rows,
      truncated: table.truncated,
    };
  }
  const png = data["image/png"];
  if (typeof png === "string") {
    return { kind: "image", mediaType: "image/png", uri: `data:image/png;base64,${png}` };
  }
  const svg = data["image/svg+xml"];
  if (typeof svg === "string") {
    const source = sanitizeNotebookSvg(svg);
    return source.length > 0
      ? { kind: "svg", source }
      : { kind: "unsupported", label: "Unsafe SVG output was withheld." };
  }
  if ("application/json" in data) {
    return {
      kind: "json",
      text: boundedText(JSON.stringify(data["application/json"], null, 2)),
    };
  }
  const text = data["text/plain"];
  if (typeof text === "string") {
    return { kind: "text", text: boundedText(text), tone: "normal" };
  }
  if ("text/html" in data) {
    return {
      kind: "unsupported",
      label: "HTML output is stored but never executed on mobile.",
    };
  }
  return {
    kind: "unsupported",
    label: "Active or unsupported notebook output is stored but not executed.",
  };
}

export function presentNotebookOutput(output: NotebookOutput): NotebookMobileOutputPresentation {
  if (output.output_type === "stream") {
    return {
      kind: "text",
      text: boundedText(output.text),
      tone: output.name === "stderr" ? "error" : "normal",
    };
  }
  if (output.output_type === "error") {
    return {
      kind: "text",
      text: boundedText([`${output.ename}: ${output.evalue}`, ...output.traceback].join("\n")),
      tone: "error",
    };
  }
  return presentMimeBundle(output.data);
}

export function notebookBookScopeLabels(
  documentIds: ReadonlyArray<string>,
  documents: ReadonlyArray<{ readonly id: string; readonly title: string }>,
): ReadonlyArray<string> {
  if (documentIds.length === 0) return ["No books mounted"];
  const titles = new Map(documents.map((document) => [document.id, document.title]));
  return documentIds.map(
    (documentId) => titles.get(documentId) ?? `Book ${documentId.slice(0, 8)}…`,
  );
}

export function notebookRevisionPresentation(
  current: NotebookRevision,
  referenced: NotebookRevision,
  latest: NotebookRevision | null,
): {
  readonly viewing: string;
  readonly canViewReferenced: boolean;
  readonly canOpenLatest: boolean;
} {
  const viewingReferenced = current.revisionId === referenced.revisionId;
  const viewingLatest = latest !== null && current.revisionId === latest.revisionId;
  return {
    viewing: viewingReferenced
      ? "Referenced revision"
      : viewingLatest
        ? "Latest saved revision"
        : "Working revision",
    canViewReferenced: !viewingReferenced,
    canOpenLatest: latest !== null && !viewingLatest,
  };
}
