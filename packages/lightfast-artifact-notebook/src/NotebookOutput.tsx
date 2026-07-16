import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { NotebookMimeBundle, NotebookOutput as NotebookOutputValue } from "./contracts.ts";
import { sandboxedNotebookHtmlDocument, sanitizeNotebookSvg } from "./notebook-sanitize.ts";
import {
  NOTEBOOK_OUTPUT_RENDER_MAX_CHARACTERS,
  NOTEBOOK_OUTPUT_RENDER_MAX_LINES,
  NOTEBOOK_TABLE_RENDER_MAX_CELLS,
  NOTEBOOK_TABLE_RENDER_MAX_COLUMNS,
  NOTEBOOK_TABLE_RENDER_MAX_ROWS,
  boundedNotebookText,
} from "./notebook-output-rendering.ts";

const OUTPUT_PREVIEW_CHARACTERS = 12_000;
const OUTPUT_PREVIEW_LINES = 80;

function BlockedMarkdownImage({ alt }: { readonly alt?: string | undefined }) {
  return (
    <span role="img" aria-label={alt ?? "Blocked external image"}>
      [image blocked]
    </span>
  );
}

const NOTEBOOK_MARKDOWN_COMPONENTS = {
  img: BlockedMarkdownImage,
} satisfies Components;

const stableValueKeys = (values: ReadonlyArray<unknown>): readonly string[] => {
  const counts = new Map<string, number>();
  return values.map((value) => {
    const serialized = JSON.stringify(value);
    const occurrence = (counts.get(serialized) ?? 0) + 1;
    counts.set(serialized, occurrence);
    return `${serialized}:${occurrence}`;
  });
};

function BoundedText({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone?: "error" | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = boundedNotebookText(text, OUTPUT_PREVIEW_CHARACTERS, OUTPUT_PREVIEW_LINES);
  const className = `overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 ${tone === "error" ? "text-destructive" : "text-foreground"}`;
  if (!preview.truncated) {
    return (
      <pre aria-label={label} className={className}>
        {text}
      </pre>
    );
  }
  const rendered = expanded
    ? boundedNotebookText(
        text,
        NOTEBOOK_OUTPUT_RENDER_MAX_CHARACTERS,
        NOTEBOOK_OUTPUT_RENDER_MAX_LINES,
      )
    : preview;
  return (
    <div>
      <pre
        aria-label={expanded ? label : `${label} preview`}
        className={`${className} ${expanded ? "max-h-[32rem]" : "max-h-80"}`}
      >
        {rendered.text}
        {rendered.truncated ? "…" : null}
      </pre>
      <button
        type="button"
        aria-expanded={expanded}
        className="mt-1 cursor-pointer rounded-sm text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "Show less" : "Show more"} {label}
      </button>
      <p className="mt-1 text-xs text-muted-foreground">
        Expanded output is render-capped; export the notebook for complete immutable revision data.
      </p>
    </div>
  );
}

export function NotebookMarkdown({ children }: { readonly children: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={NOTEBOOK_MARKDOWN_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

type DataResourceRow = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is DataResourceRow =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asDataResource = (
  value: unknown,
): {
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<DataResourceRow>;
  readonly truncated: boolean;
} | null => {
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
    columns.length === 0
      ? NOTEBOOK_TABLE_RENDER_MAX_ROWS
      : Math.floor(NOTEBOOK_TABLE_RENDER_MAX_CELLS / columns.length);
  const rowLimit = Math.min(NOTEBOOK_TABLE_RENDER_MAX_ROWS, productRowLimit);
  const rows = value.data.slice(0, rowLimit);
  return {
    columns,
    rows,
    truncated: allColumns.length > columns.length || value.data.length > rows.length,
  };
};

const cellValue = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value === null || value === undefined
      ? ""
      : JSON.stringify(value);

function NotebookTable({ value }: { readonly value: unknown }) {
  const table = asDataResource(value);
  if (table === null) {
    return (
      <div
        className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
        role="alert"
      >
        <p>Invalid notebook table data</p>
        <p>Data is preserved for export and was not rendered.</p>
      </div>
    );
  }
  const rowKeys = stableValueKeys(table.rows);
  return (
    <div>
      {table.truncated ? (
        <p className="mb-1 text-xs text-muted-foreground" role="status">
          Table output truncated to {table.rows.length} rows × {table.columns.length} columns.
          Export the notebook for complete data.
        </p>
      ) : null}
      <div
        className="max-h-80 overflow-auto"
        role="region"
        aria-label="Notebook table output"
        tabIndex={0}
      >
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-card">
            <tr>
              {table.columns.map((column) => (
                <th className="border border-border px-2 py-1 font-medium" key={column}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowKeys[rowIndex]}>
                {table.columns.map((column) => (
                  <td className="border border-border px-2 py-1" key={column}>
                    {cellValue(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MimeOutput({ data }: { readonly data: NotebookMimeBundle }) {
  const tableValue = data["application/vnd.dataresource+json"];
  if (tableValue !== undefined) {
    return <NotebookTable value={tableValue} />;
  }
  const html = data["text/html"];
  if (typeof html === "string") {
    return (
      <iframe
        className="h-48 w-full rounded-md border border-border bg-white"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={sandboxedNotebookHtmlDocument(html)}
        title="Sandboxed notebook HTML output"
      />
    );
  }
  const svg = data["image/svg+xml"];
  if (typeof svg === "string") {
    const sanitized = sanitizeNotebookSvg(svg);
    if (sanitized.length > 0) {
      return (
        <img
          alt="Notebook SVG output"
          className="max-h-96 max-w-full"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitized)}`}
        />
      );
    }
  }
  const png = data["image/png"];
  if (typeof png === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(png)) {
    return (
      <img
        alt="Notebook PNG output"
        className="max-h-96 max-w-full"
        src={`data:image/png;base64,${png}`}
      />
    );
  }
  const markdown = data["text/markdown"];
  if (typeof markdown === "string") return <NotebookMarkdown>{markdown}</NotebookMarkdown>;
  const json = data["application/json"];
  if (json !== undefined) {
    return <BoundedText label="JSON output" text={JSON.stringify(json, null, 2)} />;
  }
  const plain = data["text/plain"];
  if (typeof plain === "string") return <BoundedText label="Plain text output" text={plain} />;

  const mimeTypes = Object.keys(data);
  return (
    <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      <p>Unsupported notebook output</p>
      <p className="font-mono">{mimeTypes.join(", ") || "empty MIME bundle"}</p>
      <p>Data is preserved for export and was not executed.</p>
    </div>
  );
}

export function NotebookOutput({ output }: { readonly output: NotebookOutputValue }) {
  if (output.output_type === "stream") {
    return (
      <div
        className={`rounded-md border px-3 py-2 ${output.name === "stderr" ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/30"}`}
      >
        <BoundedText
          label={output.name === "stderr" ? "Standard error" : "Standard output"}
          text={output.text}
          tone={output.name === "stderr" ? "error" : undefined}
        />
      </div>
    );
  }
  if (output.output_type === "error") {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2"
        role="alert"
      >
        <p className="mb-1 text-xs font-semibold text-destructive">
          {output.ename}: {output.evalue}
        </p>
        <BoundedText label="Error traceback" text={output.traceback.join("\n")} tone="error" />
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <MimeOutput data={output.data} />
    </div>
  );
}
