import { handle, requireUser, canSeeHistory } from "@/lib/auth";
import { getAppName } from "@/lib/branding";
import { listWebsites, importMeta, latestRun, healthSettings } from "@/lib/websites";
import { HEALTH_LABEL, HEALTH_ORDER, FLAG_LABEL } from "@/lib/health";

export const maxDuration = 30;

/** All Websites: every site from the Duda export with its latest domain health. */
export const GET = handle(async () => {
  const me = await requireUser("member", { area: "websites" });
  const [rows, imp, last, settings, appName] = await Promise.all([listWebsites(), importMeta(), latestRun(), healthSettings(), getAppName()]);
  return Response.json({
    rows, import: imp, settings, canManage: me.role !== "member", canHistory: canSeeHistory(me), appName,
    run: last ? { ...last, status: last.stale ? "running" : last.status } : null,
    healthLabels: HEALTH_LABEL, healthOrder: HEALTH_ORDER, flagLabels: FLAG_LABEL,
  });
});
