import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turn_start_admissions
    ADD COLUMN provider_send_completed INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    ALTER TABLE projection_turn_start_admissions
    ADD COLUMN runtime_admitted INTEGER NOT NULL DEFAULT 0
  `;
});
