import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turn_start_cancellations (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      cancelled_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, provider_turn_id)
    )
  `;
});
