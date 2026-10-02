import { one } from "@/lib/db";
import { handle } from "@/lib/auth";
import { configProblems } from "@/lib/secrets";

export const GET = handle(async () => {
  const u = await one<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  const setupNeeded = !u?.n;
  // Config hints are only shown before the first account exists.
  return Response.json({ setupNeeded, missingConfig: setupNeeded ? configProblems() : [] });
});
