import { handle, requireUser } from "@/lib/auth";
import { tekFinderZip, TEK_FINDER_VERSION } from "@/lib/tekfinder";

/** Download the "Tek Finder" Chrome extension (opens a finding inside the Duda editor). */
export const GET = handle(async () => {
  await requireUser("member", { area: "projects" });
  const zip = tekFinderZip();
  return new Response(Buffer.from(zip), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="tek-finder-${TEK_FINDER_VERSION}.zip"`, "X-Content-Type-Options": "nosniff" },
  });
});
