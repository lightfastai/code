import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { NotebookDocument } from "@t3tools/lightfast-artifact-notebook/contracts";
import {
  canonicalNotebookJson,
  normalizeIpynb,
} from "@t3tools/lightfast-artifact-notebook/nbformat";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { NotebookRevisionStore, layer } from "./NotebookRevisionStore.ts";

const decodeNotebookJson = Schema.decodeUnknownEffect(Schema.fromJsonString(NotebookDocument));

const scope = {
  environmentId: EnvironmentId.make("environment-notebook-test"),
  projectId: ProjectId.make("project-notebook-test"),
};

const notebook = (source = "print(1)\n") => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: {
      name: "python3",
      display_name: "Python 3",
      language: "python",
    },
    lightfast: { title: "Immutable notebook" },
  },
  cells: [
    {
      cell_type: "code",
      id: "cell-1",
      metadata: {},
      source,
      execution_count: null,
      outputs: [],
    },
  ],
});

const testLayer = layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-notebook-revision-store-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("NotebookRevisionStore", (it) => {
  it.effect("round-trips revisions and treats duplicate saves as immutable idempotent writes", () =>
    Effect.gen(function* () {
      const store = yield* NotebookRevisionStore;
      const input = {
        scope,
        documentId: "document-1",
        notebook: notebook(),
      } as const;

      const first = yield* store.save(input);
      const duplicate = yield* store.save(input);
      const loaded = yield* store.read({
        scope,
        documentId: first.documentId,
        revisionId: first.revisionId,
      });

      assert.strictEqual(duplicate.revisionId, first.revisionId);
      assert.strictEqual(duplicate.contentHash, first.contentHash);
      assert.deepStrictEqual(loaded, first);

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM notebook_revisions
      `;
      assert.strictEqual(rows[0]?.count, 1);
    }),
  );

  it.effect("keeps an earlier revision readable after saving changed content", () =>
    Effect.gen(function* () {
      const store = yield* NotebookRevisionStore;
      const first = yield* store.save({
        scope,
        documentId: "document-history",
        notebook: notebook("print('first')\n"),
      });
      const second = yield* store.save({
        scope,
        documentId: "document-history",
        notebook: notebook("print('second')\n"),
      });

      assert.notStrictEqual(second.revisionId, first.revisionId);
      const loadedFirst = yield* store.read({
        scope,
        documentId: first.documentId,
        revisionId: first.revisionId,
      });
      assert.strictEqual(loadedFirst.document.cells[0]?.source, "print('first')\n");
    }),
  );

  it.effect("imports and exports standard ipynb JSON", () =>
    Effect.gen(function* () {
      const store = yield* NotebookRevisionStore;
      const importDocument = yield* normalizeIpynb(notebook());
      const imported = yield* store.importIpynb({
        scope,
        ipynbJson: canonicalNotebookJson(importDocument),
      });
      const exported = yield* store.exportIpynb({
        scope,
        documentId: imported.documentId,
        revisionId: imported.revisionId,
      });

      assert.deepStrictEqual(yield* decodeNotebookJson(exported), imported.document);
    }),
  );

  it.effect("verifies content hashes on every read and rejects tampered objects", () =>
    Effect.gen(function* () {
      const store = yield* NotebookRevisionStore;
      const saved = yield* store.save({
        scope,
        documentId: "document-tampered",
        notebook: notebook(),
      });
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rows = yield* sql<{ readonly objectKey: string }>`
        SELECT object_key AS "objectKey"
        FROM notebook_revisions
        WHERE document_id = ${saved.documentId}
          AND revision_id = ${saved.revisionId}
      `;
      const objectKey = rows[0]?.objectKey;
      if (!objectKey) return yield* Effect.die("Expected the revision object key.");
      yield* fileSystem.writeFileString(
        path.join(config.studyLibraryDir, ...objectKey.split("/")),
        canonicalNotebookJson(yield* normalizeIpynb(notebook("print('tampered')\n"))),
      );

      const error = yield* Effect.flip(
        store.read({
          scope,
          documentId: saved.documentId,
          revisionId: saved.revisionId,
        }),
      );
      assert.strictEqual(error.reason, "content-hash-mismatch");
    }),
  );
});
