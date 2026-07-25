import type {
  NotebookOutput,
  NotebookRevision,
} from "@t3tools/lightfast-artifact-notebook/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  beginNotebookMobileLoad,
  completeNotebookMobileLoad,
  failNotebookMobileLoad,
  notebookBookScopeLabels,
  notebookConnectionPresentation,
  notebookControlAvailability,
  notebookRevisionPresentation,
  presentNotebookOutput,
} from "./notebookMobilePresentation.ts";

const revision = (revisionId: string): NotebookRevision => ({
  documentId: "notebook-1",
  revisionId,
  contentHash: "c".repeat(64),
  kernel: { name: "python3", displayName: "Python 3", language: "python" },
  createdAt: "2026-07-25T00:00:00.000Z",
  document: {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
    },
    cells: [],
  },
});

describe("native notebook presentation", () => {
  it("preserves cached content through loading, failure, and retry", () => {
    const cached = revision("a".repeat(64));
    const loading = beginNotebookMobileLoad(cached);
    const failed = failNotebookMobileLoad(loading, "Paired Mac unavailable");
    const retrying = beginNotebookMobileLoad(failed.revision);
    const ready = completeNotebookMobileLoad(retrying, revision("b".repeat(64)));

    expect(loading).toMatchObject({ status: "loading", revision: cached });
    expect(failed).toMatchObject({
      status: "error",
      revision: cached,
      error: "Paired Mac unavailable",
    });
    expect(retrying).toMatchObject({ status: "loading", revision: cached });
    expect(ready).toMatchObject({ status: "ready", error: null });
  });

  it("keeps cached content visible but disables mutations offline and while reconnecting", () => {
    expect(notebookConnectionPresentation("offline", true)).toEqual({
      label: "Paired Mac offline · showing cached notebook",
      mutationsDisabled: true,
    });
    expect(notebookConnectionPresentation("reconnecting", true)).toEqual({
      label: "Reconnecting to paired Mac · showing cached notebook",
      mutationsDisabled: true,
    });
    expect(notebookControlAvailability("connected", false, 0)).toEqual({
      runDisabled: false,
      interruptDisabled: true,
      restartDisabled: false,
      saveDisabled: false,
    });
    expect(notebookControlAvailability("offline", true, 1)).toEqual({
      runDisabled: true,
      interruptDisabled: true,
      restartDisabled: true,
      saveDisabled: true,
    });
  });

  it("renders safe text, JSON, table, and image outputs without executing active MIME", () => {
    const outputs: NotebookOutput[] = [
      { output_type: "stream", name: "stdout", text: "hello" },
      {
        output_type: "display_data",
        metadata: {},
        data: { "application/json": { answer: 42 } },
      },
      {
        output_type: "display_data",
        metadata: {},
        data: {
          "application/vnd.dataresource+json": {
            schema: { fields: [{ name: "name" }] },
            data: [{ name: "Ada" }],
          },
        },
      },
      {
        output_type: "display_data",
        metadata: {},
        data: { "image/png": "aGVsbG8=" },
      },
      {
        output_type: "display_data",
        metadata: {},
        data: {
          "image/svg+xml":
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>safe</text></svg>',
        },
      },
      {
        output_type: "display_data",
        metadata: {},
        data: { "text/html": "<script>globalThis.pwned=true</script><b>unsafe</b>" },
      },
      {
        output_type: "display_data",
        metadata: {},
        data: { "application/javascript": "globalThis.pwned=true" },
      },
    ];

    expect(presentNotebookOutput(outputs[0]!)).toMatchObject({ kind: "text", text: "hello" });
    expect(presentNotebookOutput(outputs[1]!)).toMatchObject({
      kind: "json",
      text: '{\n  "answer": 42\n}',
    });
    expect(presentNotebookOutput(outputs[2]!)).toMatchObject({
      kind: "table",
      columns: ["name"],
    });
    expect(presentNotebookOutput(outputs[3]!)).toEqual({
      kind: "image",
      mediaType: "image/png",
      uri: "data:image/png;base64,aGVsbG8=",
    });
    expect(presentNotebookOutput(outputs[4]!)).toMatchObject({ kind: "svg" });
    expect(presentNotebookOutput(outputs[4]!)).not.toMatchObject({
      source: expect.stringContaining("<script"),
    });
    expect(presentNotebookOutput(outputs[5]!)).toEqual({
      kind: "unsupported",
      label: "HTML output is stored but never executed on mobile.",
    });
    expect(presentNotebookOutput(outputs[6]!)).toEqual({
      kind: "unsupported",
      label: "Active or unsupported notebook output is stored but not executed.",
    });
  });

  it("shows selected-book scope and immutable referenced/latest revision state", () => {
    const firstId = "1".repeat(64);
    const secondId = "2".repeat(64);
    expect(notebookBookScopeLabels([], [])).toEqual(["No books mounted"]);
    expect(
      notebookBookScopeLabels(
        [secondId, firstId],
        [
          { id: firstId, title: "Algorithms" },
          { id: secondId, title: "Statistics" },
        ],
      ),
    ).toEqual(["Statistics", "Algorithms"]);

    const referenced = revision("a".repeat(64));
    const latest = revision("b".repeat(64));
    expect(notebookRevisionPresentation(referenced, referenced, latest)).toEqual({
      viewing: "Referenced revision",
      canViewReferenced: false,
      canOpenLatest: true,
    });
    expect(notebookRevisionPresentation(latest, referenced, latest)).toEqual({
      viewing: "Latest saved revision",
      canViewReferenced: true,
      canOpenLatest: false,
    });
  });
});
