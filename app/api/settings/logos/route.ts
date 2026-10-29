import { z } from "zod";
import { handle, requireUser } from "@/lib/auth";
import { parseBody, logEvent } from "@/lib/security";
import { parseLogos, logosText, DEFAULT_LOGOS, DESIGNER } from "@/lib/logos";
import { getLogos, saveLogos } from "@/lib/logostore";

/** The logo library (certifications / affiliations / partners the designers have logos for). */
export const GET = handle(async () => {
  await requireUser("member", { area: "projects" });
  const { logos, custom } = await getLogos();
  return Response.json({ logos, text: logosText(logos), custom, designer: DESIGNER });
});

/** Replace the library with the pasted list (plain names or rows copied from Figma's layer panel), or reset it. */
export const PUT = handle(async (req: Request) => {
  const me = await requireUser("admin");
  const b = await parseBody(req, z.object({ text: z.string().max(100_000).optional(), add: z.boolean().optional(), reset: z.boolean().optional() }).strict());
  let logos = b.reset ? DEFAULT_LOGOS : parseLogos(b.text || "");
  if (!b.reset && b.add) logos = parseLogos(logosText([...(await getLogos()).logos, ...logos]));
  if (!logos.length) return Response.json({ error: "No logo names found in what you pasted." }, { status: 400 });
  await saveLogos(logos);
  await logEvent("logos.saved", me.id, { count: logos.length });
  return Response.json({ logos, text: logosText(logos), custom: true, designer: DESIGNER });
});
