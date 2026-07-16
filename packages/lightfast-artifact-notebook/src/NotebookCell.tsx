import type { ReactNode } from "react";

import type { NotebookCell as NotebookCellValue } from "./contracts.ts";
import { NotebookMarkdown, NotebookOutput } from "./NotebookOutput.tsx";

const stableOutputKeys = (cellId: string, outputs: ReadonlyArray<unknown>) => {
  const counts = new Map<string, number>();
  return outputs.map((output) => {
    const serialized = JSON.stringify(output);
    const occurrence = (counts.get(serialized) ?? 0) + 1;
    counts.set(serialized, occurrence);
    return `${cellId}:${serialized}:${occurrence}`;
  });
};

export type NotebookCellProps = {
  readonly cell: NotebookCellValue;
  readonly index: number;
  readonly total: number;
  readonly disabled?: boolean;
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
  onSourceChange,
  onRun,
  onRunAbove,
  onMove,
  onDuplicate,
  onRemove,
}: NotebookCellProps) {
  const number = index + 1;
  const outputKeys = cell.cell_type === "code" ? stableOutputKeys(cell.id, cell.outputs) : [];
  const sourceLabel = `${cell.cell_type === "code" ? "Code" : "Markdown"} cell ${number} source`;
  const action = (
    label: string,
    handler: (() => void) | undefined,
    children: ReactNode = label,
  ) => (
    <button
      type="button"
      aria-label={label}
      className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
      disabled={disabled || handler === undefined}
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
        {cell.cell_type === "code" ? action("Run cell", onRun) : null}
        {cell.cell_type === "code" ? action("Run cells above", onRunAbove) : null}
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
        {cell.cell_type === "code" && cell.outputs.length > 0 ? (
          <div aria-label={`Outputs for code cell ${number}`} className="mt-2 space-y-2">
            {cell.outputs.map((output, outputIndex) => (
              <NotebookOutput key={outputKeys[outputIndex]} output={output} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
