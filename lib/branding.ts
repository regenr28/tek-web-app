import { one, run } from "./db";
import { DEFAULT_APP_NAME } from "./credit";

/** The app's display name (top bar, sign-in page, browser tab, reports). Super Admins change it in Settings → General. */
export async function getAppName(): Promise<string> {
  try {
    const r = await one<{ value: string }>("SELECT value FROM settings WHERE key = 'app_name'");
    return r?.value?.trim() || DEFAULT_APP_NAME;
  } catch { return DEFAULT_APP_NAME; }
}
export async function saveAppName(name: string) {
  const clean = name.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!clean || clean === DEFAULT_APP_NAME) await run("DELETE FROM settings WHERE key = 'app_name'");
  else await run("INSERT INTO settings (key, value) VALUES ('app_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [clean]);
  return getAppName();
}
