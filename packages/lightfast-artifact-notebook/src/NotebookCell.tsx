import type { ReactNode } from "react";

import type {
  NotebookCell as NotebookCellValue,
  NotebookOutput as NotebookOutputValue,
} from "./contracts.ts";
import {
  notebookOutputKey,
  type NotebookOutputRetentionNotice,
} from "./notebook-output-rendering.ts";
import { NotebookMarkdown, NotebookOutput } from "./NotebookOutput.tsx";

export { notebookOutputKey } from "./notebook-output-rendering.ts";

export type NotebookCellProps = {
  readonly cell: NotebookCellValue;
  readonly index: number;
  readonly total: number;
  readonly disabled?: boolean;
  readonly runDisabled?: boolean;
  readonly renderedOutputs?: ReadonlyArray<NotebookOutputValue> | undefined;
  readonly outputKeys?: ReadonlyArray<string> | undefined;
  readonly outputRetention?: NotebookOutputRetentionNotice | null | undefined;
  readonly onSourceChange?: ((source: string) => void) | undefined;
  readonly onRun?: (() => void) | undefined;
  readonly onRunAbove?: (() => void) | undefined;
  readonly onMove?: ((direction: -1 | 1) => void) | undefined;
  readonly onDuplicate?: (() => void) | undefined;
  readonly onRemove?: (() => void) | undefined;
};

export function NotebookCell({
  cell,
  index,
  total,
  disabled = false,
  runDisabled = false,
  renderedOutputs,
  outputKeys,
  outputRetention,
  onSourceChange,
  onRun,
  onRunAbove,
  onMove,
  onDuplicate,
  onRemove,
}: NotebookCellProps) {
  const number = index + 1;
  const outputs = renderedOutputs ?? (cell.cell_type === "code" ? cell.outputs : []);
  const sourceLabel = `${cell.cell_type === "code" ? "Code" : "Markdown"} cell ${number} source`;
  const action = (
    label: string,
    handler: (() => void) | undefined,
    children: ReactNode = label,
    actionDisabled = disabled,
  ) => (
    <button
      type="button"
      aria-label={label}
      className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
      disabled={actionDisabled || handler === undefined}
      onClick={handler}
    >
      {children}
    </button>
  );

  return (
    <section
      aria-label={`${cell.cell_type === "code" ? "Code" : "Markdown"} cell ${number}`}
      className="rounded-lg border border-border bg-card"
    >
      <header className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        <span className="mr-auto text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {cell.cell_type === "code" ? `Execution ${cell.execution_count ?? "–"}` : "Markdown"}
        </span>
        {cell.cell_type === "code"
          ? action("Run cell", onRun, undefined, disabled || runDisabled)
          : null}
        {cell.cell_type === "code"
          ? action("Run cells above", onRunAbove, undefined, disabled || runDisabled)
          : null}
        {action("Move cell up", index > 0 && onMove ? () => onMove(-1) : undefined, "↑")}
        {action("Move cell down", index + 1 < total && onMove ? () => onMove(1) : undefined, "↓")}
        {action("Duplicate cell", onDuplicate, "Duplicate")}
        {action("Remove cell", onRemove, "Remove")}
      </header>
      <div className="p-2">
        <textarea
          aria-label={sourceLabel}
          className={`min-h-24 w-full resize-y rounded-md border border-border bg-background p-2 text-sm ${cell.cell_type === "code" ? "font-mono" : "font-sans"}`}
          disabled={disabled}
          onChange={(event) => onSourceChange?.(event.currentTarget.value)}
          spellCheck={cell.cell_type === "markdown"}
          value={cell.source}
        />
        {cell.cell_type === "markdown" && cell.source.trim().length > 0 ? (
          <div className="mt-2 border-t border-border pt-2">
            <NotebookMarkdown>{cell.source}</NotebookMarkdown>
          </div>
        ) : null}
        {cell.cell_type === "code" && (outputs.length > 0 || outputRetention != null) ? (
          <div aria-label={`Outputs for code cell ${number}`} className="mt-2 space-y-2">
            {outputRetention ? (
              <p
                className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                role="status"
              >
                Earlier output omitted ({outputRetention.omittedEntries} entries,{" "}
                {outputRetention.omittedBytes} bytes) to keep this notebook responsive. Export the
                notebook for complete immutable revision data.
              </p>
            ) : null}
            {outputs.map((output, outputIndex) => (
              <NotebookOutput
                key={outputKeys?.[outputIndex] ?? notebookOutputKey(cell.id, outputIndex)}
                output={output}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
