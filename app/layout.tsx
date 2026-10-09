import "./globals.css";
import type { Metadata } from "next";
import { getAppName } from "@/lib/branding";
import { headers } from "next/headers";
import { CREATOR } from "@/lib/credit";

export async function generateMetadata(): Promise<Metadata> {
  return { ...baseMetadata, title: await getAppName() };
}
const baseMetadata: Metadata = {
  description: "Website monitoring and QA for Duda sites",
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
