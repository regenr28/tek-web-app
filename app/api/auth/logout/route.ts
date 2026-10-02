import { destroySession, handle, currentUser } from "@/lib/auth";
import { logEvent } from "@/lib/security";
export const POST = handle(async () => {
  const u = await currentUser();
  await destroySession();
  if (u) await logEvent("logout", u.id);
  return Response.json({ ok: true });
});
