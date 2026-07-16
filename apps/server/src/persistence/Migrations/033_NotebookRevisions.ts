import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE notebook_documents (
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      latest_revision_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (environment_id, project_id, document_id)
    )
  `;

  yield* sql`
    CREATE TABLE notebook_revisions (
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      object_key TEXT NOT NULL,
      kernel_name TEXT NOT NULL,
      kernel_display_name TEXT NOT NULL,
      kernel_language TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (environment_id, project_id, document_id, revision_id),
      UNIQUE (environment_id, project_id, document_id, content_hash),
      FOREIGN KEY (environment_id, project_id, document_id)
        REFERENCES notebook_documents(environment_id, project_id, document_id)
        ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX idx_notebook_revisions_content_hash
    ON notebook_revisions(content_hash)
  `;
});
