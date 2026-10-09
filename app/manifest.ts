import type { MetadataRoute } from "next";
import { getAppName } from "@/lib/branding";

export const dynamic = "force-dynamic";

/** Lets the app be added to an iPhone/iPad home screen — required there for alert notifications. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const name = await getAppName();
  return { name, short_name: name.length <= 14 ? name : "Site Monitor", start_url: "/websites", display: "standalone", background_color: "#ffffff", theme_color: "#3b4bd8", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] };
}
