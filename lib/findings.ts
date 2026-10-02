import { run } from "./db";
import type { z } from "zod";
import type { FindingUpdate } from "./validators";

export async function applyUpdate(ids: number[], b: z.infer<typeof FindingUpdate>, userId: number) {
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  if (b.status) {
    await run(`UPDATE findings SET status = ?, done_by = ?, done_at = ${b.status === "open" ? "NULL" : "datetime('now')"}, updated_at = datetime('now') WHERE id IN (${ph})`,
      [b.status, b.status === "open" ? null : userId, ...ids]);
  }
  if (b.assignee_id !== undefined) await run(`UPDATE findings SET assignee_id = ?, updated_at = datetime('now') WHERE id IN (${ph})`, [b.assignee_id, ...ids]);
  if (b.note !== undefined) await run(`UPDATE findings SET note = ?, updated_at = datetime('now') WHERE id IN (${ph})`, [b.note || null, ...ids]);
}
