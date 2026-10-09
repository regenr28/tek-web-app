import "./globals.css";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { CREATOR } from "@/lib/credit";

export const metadata: Metadata = {
  title: "Duda Preview Audit",
  description: "QA audits for Duda sites from preview links",
  authors: [{ name: CREATOR }],
  creator: CREATOR,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading headers makes every page render per-request, so Next.js can stamp its scripts with the CSP nonce.
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
