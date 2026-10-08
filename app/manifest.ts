import type { MetadataRoute } from "next";

/** Lets the app be added to an iPhone/iPad home screen — required there for alert notifications. */
export default function manifest(): MetadataRoute.Manifest {
  return { name: "Duda Preview Audit", short_name: "Site Audit", start_url: "/websites", display: "standalone", background_color: "#ffffff", theme_color: "#3b4bd8", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] };
}
