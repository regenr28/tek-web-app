import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), serial=(), hid=(), interest-cohort=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  // Internal tool: keep it out of search engines
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  serverExternalPackages: ["@libsql/client", "unpdf", "@sparticuz/chromium", "puppeteer-core"],
  // headless Chrome (rendered audits + finding screenshots) needs its compressed binary shipped with these functions
  outputFileTracingIncludes: {
    // ("[id]" would be read as a glob character class, so match the routes with wildcards)
    "/api/sites/*/audit/page": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/findings/*/shot": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/findings/*/view": ["./node_modules/@sparticuz/chromium/bin/**"],
    // the audit runs as a background job (workers render pages in Chrome)
    "/api/sites/*/audit/job": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/sites/*/audit/work": ["./node_modules/@sparticuz/chromium/bin/**"],
    // research reads a website's social icons in Chrome when they're added with script
    "/api/sites/*/collection/job": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/sites/*/collection/run": ["./node_modules/@sparticuz/chromium/bin/**"],
    "/api/jobs/*/continue": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
      // the in-app page viewer is shown in a frame of this app (it sets its own strict CSP)
      { source: "/api/findings/:id/view", headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] },
    ];
  },
};

export default nextConfig;
