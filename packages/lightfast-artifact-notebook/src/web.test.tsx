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
  notebookWebCapability,
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

  it("collapses oversized output behind an accessible expansion control", () => {
    const html = renderOutput({
      output_type: "stream",
      name: "stdout",
      text: "line\n".repeat(500),
    });

    expect(html).toContain("<details");
    expect(html).toContain("Show complete Standard output");
  });
});
