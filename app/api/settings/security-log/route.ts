import { all } from "@/lib/db";
import { handle, requireUser } from "@/lib/auth";

export const GET = handle(async () => {
  await requireUser("super_admin");
  return Response.json(await all(
    `SELECT e.id, e.at, e.event, e.ip, e.detail, u.name AS user_name, u.email AS user_email
     FROM security_events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT 300`));
});
