import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261105155559_task-parent",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`task_parent_id\` text;`)
      yield* tx.run(`CREATE INDEX \`session_v2_task_parent_idx\` ON \`session_v2\` (\`task_parent_id\`);`)
    })
  },
}

export default migration
