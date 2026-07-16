import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { notebookArtifactDefinition } from "./contracts.ts";
import type {
  NotebookCell as NotebookCellValue,
  NotebookOutput as NotebookOutputValue,
} from "./contracts.ts";
import {
  NotebookCell,
  NotebookOutput,
  NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_CELL,
  NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_SESSION,
  NOTEBOOK_OUTPUT_RENDER_MAX_CHARACTERS,
  NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_CELL,
  NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_SESSION,
  NOTEBOOK_OUTPUT_RENDER_MAX_LINES,
  NOTEBOOK_TABLE_RENDER_MAX_CELLS,
  NOTEBOOK_TABLE_RENDER_MAX_COLUMNS,
  NOTEBOOK_TABLE_RENDER_MAX_ROWS,
  boundedNotebookText,
  notebookOutputKey,
  notebookWebCapability,
  planNotebookOutputRendering,
  sanitizeNotebookSvg,
} from "./web.tsx";

const renderOutput = (output: NotebookOutputValue) =>
  renderToStaticMarkup(createElement(NotebookOutput, { output }));

describe("notebook web capability", () => {
  it("owns the versioned notebook registration descriptor", () => {
    expect(notebookWebCapability.artifactDefinition).toBe(notebookArtifactDefinition);
    expect(notebookWebCapability.artifactDefinition.kind).toBe("notebook");
    expect(notebookWebCapability.artifactDefinition.schemaVersion).toBe(1);
  });
});

describe("NotebookCell", () => {
  it("keys outputs by stable cell identity and output position", () => {
    expect(notebookOutputKey("code-1", 0)).toBe("code-1-output-0");
    expect(notebookOutputKey("code-1", 2)).toBe("code-1-output-2");
  });

  it("preserves runtime output keys when older entries are omitted", () => {
    const outputs = Array.from(
      { length: NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_CELL + 2 },
      (_, index): NotebookOutputValue => ({
        output_type: "stream",
        name: "stdout",
        text: `entry-${index}`,
      }),
    );
    const outputKeys = outputs.map((_, index) => `runtime-key-${index}`);
    const plan = planNotebookOutputRendering([{ cellId: "code-1", outputs, outputKeys }]).get(
      "code-1",
    );

    expect(plan?.outputs).toHaveLength(NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_CELL);
    expect(plan?.outputKeys[0]).toBe("runtime-key-2");
    expect(plan?.retention?.omittedEntries).toBe(2);
    expect(outputs).toHaveLength(NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_CELL + 2);
  });

  it("renders Markdown cells without executing embedded HTML", () => {
    const cell: NotebookCellValue = {
      cell_type: "markdown",
      id: "markdown-1",
      metadata: {},
      source: "# Safe heading\n<script>alert('no')</script>\n**important**",
    };

    const html = renderToStaticMarkup(createElement(NotebookCell, { cell, index: 0, total: 1 }));

    expect(html).toContain("Safe heading");
    expect(html).toContain("important");
    expect(html).not.toContain("<script>");
    expect(html).toContain("textarea");
    expect(html).toContain('aria-label="Markdown cell 1 source"');
  });

  it("renders editable code source and execution count with semantic controls", () => {
    const cell: NotebookCellValue = {
      cell_type: "code",
      id: "code-1",
      metadata: {},
      source: "print('hello')",
      execution_count: 7,
      outputs: [],
    };

    const html = renderToStaticMarkup(createElement(NotebookCell, { cell, index: 0, total: 1 }));

    expect(html).toContain("print(&#x27;hello&#x27;)");
    expect(html).toContain("Execution 7");
    expect(html).toContain('aria-label="Code cell 1 source"');
    expect(html).toContain("Run cell");
  });

  it("renders an explicit notice when output has been omitted", () => {
    const cell: NotebookCellValue = {
      cell_type: "code",
      id: "code-omitted",
      metadata: {},
      source: "print('many rows')",
      execution_count: 1,
      outputs: [],
    };

    const html = renderToStaticMarkup(
      createElement(NotebookCell, {
        cell,
        index: 0,
        total: 1,
        renderedOutputs: [],
        outputRetention: { omittedEntries: 4, omittedBytes: 8192 },
      }),
    );

    expect(html).toContain("Earlier output omitted (4 entries, 8192 bytes)");
    expect(html).toContain("Export the notebook");
  });
});

describe("NotebookOutput", () => {
  it("renders stdout and stderr as bounded plain text", () => {
    const stdout = renderOutput({ output_type: "stream", name: "stdout", text: "hello\n" });
    const stderr = renderOutput({ output_type: "stream", name: "stderr", text: "warning\n" });

    expect(stdout).toContain("Standard output");
    expect(stdout).toContain("hello");
    expect(stderr).toContain("Standard error");
    expect(stderr).toContain("warning");
  });

  it("renders text/plain, Markdown, JSON, and PNG MIME values", () => {
    const plain = renderOutput({
      output_type: "display_data",
      metadata: {},
      data: { "text/plain": "plain value" },
    });
    const markdown = renderOutput({
      output_type: "display_data",
      metadata: {},
      data: { "text/markdown": "## Result\n**safe**" },
    });
    const json = renderOutput({
      output_type: "execute_result",
      execution_count: 2,
      metadata: {},
      data: { "application/json": { ok: true, rows: [1, 2] } },
    });
    const png = renderOutput({
      output_type: "display_data",
      metadata: {},
      data: { "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" },
    });

    expect(plain).toContain("plain value");
    expect(markdown).toContain("Result");
    expect(markdown).toContain("<strong>safe</strong>");
    expect(json).toContain("&quot;ok&quot;: true");
    expect(png).toContain("data:image/png;base64,iVBORw0K");
    expect(png).toContain("Notebook PNG output");
  });

  it("sanitizes SVG scripts, event handlers, and external references", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">',
      '<script>alert("x")</script>',
      '<image href="https://tracker.example/pixel"/>',
      '<rect width="10" height="10" fill="#0f0"/>',
      "</svg>",
    ].join("");
    const sanitized = sanitizeNotebookSvg(svg);

    expect(sanitized).toContain("<svg");
    expect(sanitized).toContain("<rect");
    expect(sanitized).not.toMatch(/script|onload|https:|href/i);

    const html = renderOutput({
      output_type: "display_data",
      metadata: {},
      data: { "image/svg+xml": svg },
    });
    expect(html).toContain("data:image/svg+xml");
    expect(html).not.toMatch(/script|onload|tracker\.example/i);
  });

  it("preserves the safe SVG namespace and canonical case required by XML renderers", () => {
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
      '<defs><linearGradient id="paint" gradientUnits="userSpaceOnUse">',
      '<stop offset="0" stop-color="#fff"/>',
      "</linearGradient></defs>",
      '<rect width="10" height="10" fill="#fff"/>',
      "</svg>",
    ].join("");
    const sanitized = sanitizeNotebookSvg(svg);

    expect(sanitized).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(sanitized).toContain('viewBox="0 0 10 10"');
    expect(sanitized).toContain("<linearGradient");
    expect(sanitized).toContain('gradientUnits="userSpaceOnUse"');
    expect(sanitized).not.toContain("viewbox");
    expect(sanitized).not.toContain("lineargradient");

    const html = renderOutput({
      output_type: "display_data",
      metadata: {},
      data: { "image/svg+xml": svg },
    });
    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("viewBox");
    expect(html).toContain("linearGradient");
  });

  it("renders tabular data with named columns and rows", () => {
    const html = renderOutput({
      output_type: "display_data",
      metadata: {},
      data: {
        "application/vnd.dataresource+json": {
          schema: { fields: [{ name: "name" }, { name: "score" }] },
          data: [
            { name: "Ada", score: 10 },
            { name: "Grace", score: 9 },
          ],
        },
      },
    });

    expect(html).toContain("<table");
    expect(html).toContain("name");
    expect(html).toContain("score");
    expect(html).toContain("Ada");
    expect(html).toContain("Grace");
  });

  it("renders an invalid-data fallback for malformed table fields and rows", () => {
    const malformedValues = [
      {
        schema: { fields: [null] },
        data: [{}],
      },
      {
        schema: { fields: [{ name: "name" }] },
        data: [null],
      },
    ];

    for (const value of malformedValues) {
      const html = renderOutput({
        output_type: "display_data",
        metadata: {},
        data: { "application/vnd.dataresource+json": value },
      });
      expect(html).toContain("Invalid notebook table data");
      expect(html).toContain("preserved for export");
      expect(html).not.toContain("<table");
    }
  });

  it("caps rows, columns, and their product for compact wide table payloads", () => {
    const columns = Array.from({ length: 100 }, (_, index) => `column-${index}`);
    const row = Object.fromEntries(columns.map((column, index) => [column, index]));
    const html = renderOutput({
      output_type: "display_data",
      metadata: {},
      data: {
        "application/vnd.dataresource+json": {
          schema: { fields: columns.map((name) => ({ name })) },
          data: Array.from({ length: 1_000 }, () => row),
        },
      },
    });
    const renderedColumns = html.match(/<th(?:\s|>)/g)?.length ?? 0;
    const renderedCells = html.match(/<td(?:\s|>)/g)?.length ?? 0;
    const renderedRows = html.match(/<tr(?:\s|>)/g)?.length ?? 1;

    expect(renderedColumns).toBeLessThanOrEqual(NOTEBOOK_TABLE_RENDER_MAX_COLUMNS);
    expect(renderedRows - 1).toBeLessThanOrEqual(NOTEBOOK_TABLE_RENDER_MAX_ROWS);
    expect(renderedCells).toBeLessThanOrEqual(NOTEBOOK_TABLE_RENDER_MAX_CELLS);
    expect(html).toContain("Table output truncated");
  });

  it("renders tracebacks as text without interpreting terminal markup", () => {
    const html = renderOutput({
      output_type: "error",
      ename: "ValueError",
      evalue: "bad <script>alert(1)</script>",
      traceback: ["Traceback", "ValueError: bad"],
    });

    expect(html).toContain("ValueError");
    expect(html).toContain("Traceback");
    expect(html).not.toContain("<script>");
  });

  it("isolates HTML in a scriptless sandbox with external loads disabled", () => {
    const html = renderOutput({
      output_type: "display_data",
      metadata: {},
      data: {
        "text/html": '<script>alert(1)</script><img src="https://tracker.example/x"><b>safe</b>',
      },
    });

    expect(html).toContain("<iframe");
    expect(html).toContain('sandbox=""');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("default-src &#x27;none&#x27;");
    expect(html).not.toContain("allow-scripts");
    expect(html).not.toContain("tracker.example");
    expect(html).not.toContain("&lt;script");
  });

  it("preserves unsupported MIME types behind a non-executing fallback", () => {
    const html = renderOutput({
      output_type: "display_data",
      metadata: {},
      data: { "application/x-vendor-widget": { javascript: "alert(1)" } },
    });

    expect(html).toContain("Unsupported notebook output");
    expect(html).toContain("application/x-vendor-widget");
    expect(html).toContain("preserved for export");
    expect(html).not.toContain("alert(1)");
  });

  it("does not mount complete oversized text while collapsed and caps expanded rendering", () => {
    const endMarker = "COMPLETE-OUTPUT-END";
    const html = renderOutput({
      output_type: "stream",
      name: "stdout",
      text: `${"line\n".repeat(5_000)}${endMarker}`,
    });

    const expanded = boundedNotebookText(
      `${"line\n".repeat(5_000)}${endMarker}`,
      NOTEBOOK_OUTPUT_RENDER_MAX_CHARACTERS,
      NOTEBOOK_OUTPUT_RENDER_MAX_LINES,
    );

    expect(html).toContain("Show more Standard output");
    expect(html).toContain("export the notebook");
    expect(html).not.toContain("<details");
    expect(html).not.toContain(endMarker);
    expect(expanded.truncated).toBe(true);
    expect(expanded.text).not.toContain(endMarker);
  });

  it("bounds mounted output entries and bytes across many cells without mutating source data", () => {
    const inputs = Array.from({ length: 20 }, (_, cellIndex) => ({
      cellId: `code-${cellIndex}`,
      outputs: Array.from(
        { length: NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_CELL + 4 },
        (_, outputIndex): NotebookOutputValue => ({
          output_type: "display_data",
          metadata: {},
          data: { "text/plain": `${cellIndex}-${outputIndex}-${"x".repeat(4_096)}` },
        }),
      ),
    }));
    const originalEntryCount = inputs.reduce((total, input) => total + input.outputs.length, 0);
    const plan = planNotebookOutputRendering(inputs);
    const retainedEntries = [...plan.values()].reduce(
      (total, item) => total + item.outputs.length,
      0,
    );
    const retainedBytes = [...plan.values()].reduce((total, item) => total + item.retainedBytes, 0);

    expect(retainedEntries).toBeLessThanOrEqual(NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_SESSION);
    expect(retainedBytes).toBeLessThanOrEqual(NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_SESSION);
    expect(
      [...plan.values()].every(
        (item) =>
          item.outputs.length <= NOTEBOOK_OUTPUT_RENDER_MAX_ENTRIES_PER_CELL &&
          item.retainedBytes <= NOTEBOOK_OUTPUT_RENDER_MAX_BYTES_PER_CELL,
      ),
    ).toBe(true);
    expect(
      [...plan.values()].reduce((total, item) => total + (item.retention?.omittedEntries ?? 0), 0),
    ).toBeGreaterThan(0);
    expect(inputs.reduce((total, input) => total + input.outputs.length, 0)).toBe(
      originalEntryCount,
    );
  });
});
