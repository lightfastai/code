import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  NOTEBOOK_CELL_SOURCE_MAX_BYTES,
  NOTEBOOK_MAX_MIME_BUNDLE_ENTRIES,
  NOTEBOOK_MIME_KEY_MAX_LENGTH,
  NOTEBOOK_MIME_VALUE_MAX_BYTES,
  NOTEBOOK_OUTPUT_MAX_BYTES,
} from "./contracts.ts";
import { canonicalNotebookJson, hashNotebook, normalizeIpynb } from "./nbformat.ts";

const rawNotebook = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: {
      name: "python3",
      display_name: "Python 3",
      language: "python",
    },
    lightfast: {
      title: "Vectors",
    },
  },
  cells: [
    {
      cell_type: "markdown",
      id: "intro",
      metadata: {},
      source: ["# Vectors\n", "A vector has magnitude and direction."],
    },
    {
      cell_type: "code",
      id: "code-1",
      metadata: {},
      source: "print('hello')\n",
      execution_count: 1,
      outputs: [
        {
          output_type: "execute_result",
          execution_count: 1,
          metadata: {},
          data: {
            "text/plain": ["hello", "\n"],
            "application/json": { ok: true },
            "application/x-unsafe": { script: "alert(1)" },
          },
        },
      ],
    },
  ],
  ...overrides,
});

const notebookWithMimeData = (data: Readonly<Record<string, unknown>>) =>
  rawNotebook({
    cells: [
      {
        cell_type: "code",
        id: "mime-bounds",
        metadata: {},
        source: "display(value)",
        execution_count: 1,
        outputs: [{ output_type: "display_data", metadata: {}, data }],
      },
    ],
  });

describe("normalizeIpynb", () => {
  it.effect("normalizes supported MIME values without discarding unsupported JSON MIME data", () =>
    Effect.gen(function* () {
      const notebook = yield* normalizeIpynb(rawNotebook());

      assert.strictEqual(
        notebook.cells[0]?.source,
        "# Vectors\nA vector has magnitude and direction.",
      );
      assert.strictEqual(notebook.cells[1]?.source, "print('hello')\n");
      const output = notebook.cells[1]?.cell_type === "code" ? notebook.cells[1].outputs[0] : null;
      assert.isNotNull(output);
      if (output?.output_type !== "execute_result") return;
      assert.strictEqual(output.data["text/plain"], "hello\n");
      assert.deepStrictEqual(output.data["application/json"], { ok: true });
      assert.deepStrictEqual(output.data["application/x-unsafe"], { script: "alert(1)" });
    }),
  );

  it.effect("assigns deterministic unique nbformat-compatible cell IDs", () =>
    Effect.gen(function* () {
      const input = rawNotebook({
        cells: [
          { cell_type: "markdown", metadata: {}, source: "one" },
          { cell_type: "markdown", id: "duplicate", metadata: {}, source: "two" },
          { cell_type: "markdown", id: "duplicate", metadata: {}, source: "three" },
        ],
      });
      const first = yield* normalizeIpynb(input);
      const second = yield* normalizeIpynb(input);
      const ids = first.cells.map((cell) => cell.id);

      assert.deepStrictEqual(
        ids,
        second.cells.map((cell) => cell.id),
      );
      assert.strictEqual(new Set(ids).size, ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }),
  );

  it.effect("keeps duplicate IDs valid at the maximum cell cardinality", () =>
    Effect.gen(function* () {
      const duplicateId = "x".repeat(64);
      const input = rawNotebook({
        cells: Array.from({ length: 1_000 }, () => ({
          cell_type: "markdown",
          id: duplicateId,
          metadata: {},
          source: "cell",
        })),
      });
      const first = yield* normalizeIpynb(input);
      const second = yield* normalizeIpynb(input);
      const ids = first.cells.map((cell) => cell.id);

      assert.strictEqual(ids.length, 1_000);
      assert.strictEqual(new Set(ids).size, ids.length);
      assert.strictEqual(canonicalNotebookJson(first), canonicalNotebookJson(second));
      for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }),
  );

  it.effect("rejects oversized cell sources", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        normalizeIpynb(
          rawNotebook({
            cells: [
              {
                cell_type: "markdown",
                id: "large",
                metadata: {},
                source: "x".repeat(NOTEBOOK_CELL_SOURCE_MAX_BYTES + 1),
              },
            ],
          }),
        ),
      );

      assert.strictEqual(error.reason, "limit-exceeded");
    }),
  );

  it.effect("bounds MIME keys, entry counts, values, and serialized bundles", () =>
    Effect.gen(function* () {
      const entryCountError = yield* Effect.flip(
        normalizeIpynb(
          notebookWithMimeData(
            Object.fromEntries(
              Array.from({ length: NOTEBOOK_MAX_MIME_BUNDLE_ENTRIES + 1 }, (_, index) => [
                `application/x-entry-${index}`,
                index,
              ]),
            ),
          ),
        ),
      );
      assert.strictEqual(entryCountError.reason, "limit-exceeded");

      const keyLengthError = yield* Effect.flip(
        normalizeIpynb(
          notebookWithMimeData({
            [`application/${"x".repeat(NOTEBOOK_MIME_KEY_MAX_LENGTH)}`]: true,
          }),
        ),
      );
      assert.strictEqual(keyLengthError.reason, "invalid-notebook");

      const valueSizeError = yield* Effect.flip(
        normalizeIpynb(
          notebookWithMimeData({
            "application/x-large-value": "x".repeat(NOTEBOOK_MIME_VALUE_MAX_BYTES),
          }),
        ),
      );
      assert.strictEqual(valueSizeError.reason, "limit-exceeded");

      const halfBundle = Math.floor(NOTEBOOK_OUTPUT_MAX_BYTES / 2) + 1_024;
      const bundleSizeError = yield* Effect.flip(
        normalizeIpynb(
          notebookWithMimeData({
            "application/x-large-a": "a".repeat(halfBundle),
            "application/x-large-b": "b".repeat(halfBundle),
          }),
        ),
      );
      assert.strictEqual(bundleSizeError.reason, "limit-exceeded");
    }),
  );
});

describe("canonical notebook hashing", () => {
  it.effect("produces the same canonical JSON and SHA-256 across object key order", () =>
    Effect.gen(function* () {
      const first = yield* normalizeIpynb(rawNotebook());
      const second = yield* normalizeIpynb({
        cells: rawNotebook().cells,
        metadata: rawNotebook().metadata,
        nbformat_minor: 5,
        nbformat: 4,
      });

      assert.strictEqual(canonicalNotebookJson(first), canonicalNotebookJson(second));
      assert.strictEqual(yield* hashNotebook(first), yield* hashNotebook(second));
      expect(yield* hashNotebook(first)).toMatch(/^[a-f0-9]{64}$/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
