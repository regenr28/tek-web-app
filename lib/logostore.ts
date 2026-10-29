import { one, run } from "./db";
import { DEFAULT_LOGOS, type Logo } from "./logos";

export async function getLogos(): Promise<{ logos: Logo[]; custom: boolean }> {
  const r = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'logo_library'").catch(() => null);
  if (r) { try { const v = JSON.parse(r.value) as { logos?: Logo[] }; if (Array.isArray(v.logos)) return { logos: v.logos, custom: true }; } catch { /* default */ } }
  return { logos: DEFAULT_LOGOS, custom: false };
}
export async function saveLogos(logos: Logo[]) {
  await run("INSERT INTO settings (key, value) VALUES ('logo_library', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify({ logos })]);
  return logos;
}
