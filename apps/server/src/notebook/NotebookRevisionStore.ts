import {
  NotebookDocumentId,
  NotebookRevisionError,
  type NotebookDocument,
  type NotebookRevision,
} from "@t3tools/lightfast-artifact-notebook/contracts";
import {
  canonicalNotebookJson,
  hashNotebook,
  normalizeIpynb,
  notebookKernel,
} from "@t3tools/lightfast-artifact-notebook/nbformat";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

export interface NotebookRevisionScope {
  readonly environmentId: string;
  readonly projectId: string;
}

export interface NotebookSaveInput {
  readonly scope: NotebookRevisionScope;
  readonly documentId: string;
  readonly notebook: unknown;
}

export interface NotebookReadInput {
  readonly scope: NotebookRevisionScope;
  readonly documentId: string;
  readonly revisionId: string;
}

export interface NotebookImportInput {
  readonly scope: NotebookRevisionScope;
  readonly ipynbJson: string;
  readonly documentId?: string;
}

export type NotebookRevisionStoreShape = {
  readonly save: (
    input: NotebookSaveInput,
  ) => Effect.Effect<NotebookRevision, NotebookRevisionError>;
  readonly read: (
    input: NotebookReadInput,
  ) => Effect.Effect<NotebookRevision, NotebookRevisionError>;
  readonly importIpynb: (
    input: NotebookImportInput,
  ) => Effect.Effect<NotebookRevision, NotebookRevisionError>;
  readonly exportIpynb: (input: NotebookReadInput) => Effect.Effect<string, NotebookRevisionError>;
};

export class NotebookRevisionStore extends Context.Service<
  NotebookRevisionStore,
  NotebookRevisionStoreShape
>()("t3/notebook/NotebookRevisionStore") {}

type RevisionRow = {
  readonly documentId: string;
  readonly revisionId: string;
  readonly contentHash: string;
  readonly objectKey: string;
  readonly kernelName: string;
  readonly kernelDisplayName: string;
  readonly kernelLanguage: string;
  readonly createdAt: string;
};

const decodeDocumentId = Schema.decodeUnknownEffect(NotebookDocumentId);
const isNotebookRevisionError = Schema.is(NotebookRevisionError);

const storageError = (message: string) =>
  new NotebookRevisionError({ reason: "storage-failed", message });

const revisionNotFound = () =>
  new NotebookRevisionError({
    reason: "not-found",
    message: "The requested notebook revision does not exist in this project.",
  });

const hashMismatch = () =>
  new NotebookRevisionError({
    reason: "content-hash-mismatch",
    message: "The immutable notebook revision failed content hash verification.",
  });

const normalizeDocumentId = Effect.fn("NotebookRevisionStore.normalizeDocumentId")(function* (
  documentId: string,
) {
  return yield* decodeDocumentId(documentId).pipe(
    Effect.mapError(
      () =>
        new NotebookRevisionError({
          reason: "invalid-notebook",
          message: "Notebook document ID is invalid.",
        }),
    ),
  );
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const notebookRoot = path.join(config.studyLibraryDir, "notebooks");
  const hash = (document: NotebookDocument) =>
    hashNotebook(document).pipe(Effect.provideService(Crypto.Crypto, crypto));

  const objectPath = (objectKey: string) =>
    path.join(config.studyLibraryDir, ...objectKey.split("/"));

  const verifyObject = Effect.fn("NotebookRevisionStore.verifyObject")(function* (
    row: RevisionRow,
  ) {
    const filePath = objectPath(row.objectKey);
    const raw = yield* fileSystem
      .readFileString(filePath)
      .pipe(Effect.mapError(() => hashMismatch()));
    const document = yield* normalizeIpynb(raw).pipe(Effect.mapError(() => hashMismatch()));
    const canonical = canonicalNotebookJson(document);
    if (raw !== canonical) return yield* hashMismatch();
    const contentHash = yield* hash(document).pipe(Effect.mapError(() => hashMismatch()));
    const kernel = notebookKernel(document);
    if (
      contentHash !== row.contentHash ||
      row.revisionId !== row.contentHash ||
      kernel.name !== row.kernelName ||
      kernel.displayName !== row.kernelDisplayName ||
      kernel.language !== row.kernelLanguage
    ) {
      return yield* hashMismatch();
    }
    return document;
  });

  const findRevision = Effect.fn("NotebookRevisionStore.findRevision")(function* (
    input: NotebookReadInput,
  ) {
    const rows = yield* sql<RevisionRow>`
      SELECT
        document_id AS "documentId",
        revision_id AS "revisionId",
        content_hash AS "contentHash",
        object_key AS "objectKey",
        kernel_name AS "kernelName",
        kernel_display_name AS "kernelDisplayName",
        kernel_language AS "kernelLanguage",
        created_at AS "createdAt"
      FROM notebook_revisions
      WHERE environment_id = ${input.scope.environmentId}
        AND project_id = ${input.scope.projectId}
        AND document_id = ${input.documentId}
        AND revision_id = ${input.revisionId}
      LIMIT 1
    `.pipe(Effect.mapError(() => storageError("Could not query the notebook revision index.")));
    const row = rows[0];
    if (row === undefined) return yield* revisionNotFound();
    return row;
  });

  const read: NotebookRevisionStoreShape["read"] = Effect.fn("NotebookRevisionStore.read")(
    function* (input) {
      const row = yield* findRevision(input);
      const document = yield* verifyObject(row);
      return {
        documentId: NotebookDocumentId.make(row.documentId),
        revisionId: row.revisionId as NotebookRevision["revisionId"],
        contentHash: row.contentHash as NotebookRevision["contentHash"],
        kernel: {
          name: row.kernelName,
          displayName: row.kernelDisplayName,
          language: row.kernelLanguage,
        },
        document,
        createdAt: row.createdAt,
      };
    },
  );

  const persistObject = Effect.fn("NotebookRevisionStore.persistObject")(function* (
    document: NotebookDocument,
    contentHash: string,
    objectKey: string,
  ) {
    const filePath = objectPath(objectKey);
    const exists = yield* fileSystem
      .exists(filePath)
      .pipe(Effect.mapError(() => storageError("Could not inspect the notebook object store.")));
    if (exists) {
      yield* verifyObject({
        documentId: "existing-object",
        revisionId: contentHash,
        contentHash,
        objectKey,
        kernelName: document.metadata.kernelspec.name,
        kernelDisplayName: document.metadata.kernelspec.display_name,
        kernelLanguage: document.metadata.kernelspec.language,
        createdAt: "",
      });
      return;
    }
    yield* writeFileStringAtomically({
      filePath,
      contents: canonicalNotebookJson(document),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => storageError("Could not persist the notebook revision object.")),
    );
  });

  const save: NotebookRevisionStoreShape["save"] = Effect.fn("NotebookRevisionStore.save")(
    function* (input) {
      const documentId = yield* normalizeDocumentId(input.documentId);
      const document = yield* normalizeIpynb(input.notebook);
      const contentHash = yield* hash(document);
      const revisionId = contentHash;
      const kernel = notebookKernel(document);
      const objectKey = `notebooks/objects/${contentHash.slice(0, 2)}/${contentHash}.json`;
      yield* fileSystem
        .makeDirectory(notebookRoot, { recursive: true })
        .pipe(
          Effect.mapError(() => storageError("Could not initialize the notebook object store.")),
        );
      yield* persistObject(document, contentHash, objectKey);
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));

      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
            INSERT INTO notebook_documents (
              environment_id,
              project_id,
              document_id,
              latest_revision_id,
              created_at,
              updated_at
            ) VALUES (
              ${input.scope.environmentId},
              ${input.scope.projectId},
              ${documentId},
              ${revisionId},
              ${now},
              ${now}
            )
            ON CONFLICT (environment_id, project_id, document_id) DO NOTHING
          `;
            yield* sql`
            INSERT INTO notebook_revisions (
              environment_id,
              project_id,
              document_id,
              revision_id,
              content_hash,
              object_key,
              kernel_name,
              kernel_display_name,
              kernel_language,
              created_at
            ) VALUES (
              ${input.scope.environmentId},
              ${input.scope.projectId},
              ${documentId},
              ${revisionId},
              ${contentHash},
              ${objectKey},
              ${kernel.name},
              ${kernel.displayName},
              ${kernel.language},
              ${now}
            )
            ON CONFLICT (environment_id, project_id, document_id, revision_id) DO NOTHING
          `;
            const persisted = yield* findRevision({
              scope: input.scope,
              documentId,
              revisionId,
            });
            if (persisted.contentHash !== contentHash || persisted.objectKey !== objectKey) {
              return yield* new NotebookRevisionError({
                reason: "immutable-conflict",
                message: "The notebook revision ID is already bound to different content.",
              });
            }
            yield* sql`
            UPDATE notebook_documents
            SET latest_revision_id = ${revisionId}, updated_at = ${now}
            WHERE environment_id = ${input.scope.environmentId}
              AND project_id = ${input.scope.projectId}
              AND document_id = ${documentId}
          `;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isNotebookRevisionError(cause)
              ? cause
              : storageError("Could not update the notebook revision index."),
          ),
        );

      return yield* read({ scope: input.scope, documentId, revisionId });
    },
  );

  const importIpynb: NotebookRevisionStoreShape["importIpynb"] = Effect.fn(
    "NotebookRevisionStore.importIpynb",
  )(function* (input) {
    const document = yield* normalizeIpynb(input.ipynbJson);
    const generatedId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() => storageError("Could not generate a notebook document ID.")),
    );
    const documentId =
      input.documentId ??
      document.metadata.lightfast?.sourceDocumentId ??
      `notebook-${generatedId}`;
    return yield* save({ scope: input.scope, documentId, notebook: document });
  });

  const exportIpynb: NotebookRevisionStoreShape["exportIpynb"] = Effect.fn(
    "NotebookRevisionStore.exportIpynb",
  )(function* (input) {
    const revision = yield* read(input);
    return canonicalNotebookJson(revision.document);
  });

  return NotebookRevisionStore.of({ save, read, importIpynb, exportIpynb });
});

export const layer = Layer.effect(NotebookRevisionStore, make);
