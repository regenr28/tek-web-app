import { HttpError } from "./security";

export async function idOf(ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  if (!/^\d{1,10}$/.test(raw)) throw new HttpError(400, "Bad id");
  return Number(raw);
}
export type Ctx = { params: Promise<{ id: string }> };
