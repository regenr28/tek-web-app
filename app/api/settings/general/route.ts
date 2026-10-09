import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { getAppName, saveAppName } from "@/lib/branding";
import { DEFAULT_APP_NAME } from "@/lib/credit";

/** Settings → General (Super Admin): the app's display name. */
export const GET = handle(async () => {
  await requireUser("super_admin");
  return Response.json({ appName: await getAppName(), defaultName: DEFAULT_APP_NAME });
});

const Body = z.object({ appName: z.string().max(60) }).strict();

export const PUT = handle(async (req: Request) => {
  const me = await requireUser("super_admin");
  const b = await parseBody(req, Body);
  const appName = await saveAppName(b.appName);
  await logEvent("settings.app_name_changed", me.id, { appName });
  return Response.json({ appName, defaultName: DEFAULT_APP_NAME });
});
