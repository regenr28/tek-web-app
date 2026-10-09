import { redirect } from "next/navigation";
import { currentUser, canSee } from "@/lib/auth";
import { publicMe } from "@/lib/pageAuth";
import TopBar from "@/components/TopBar";
import { CREDIT } from "@/lib/credit";
import { getAppName } from "@/lib/branding";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await currentUser();
  if (!me) redirect("/login");
  const appName = await getAppName();
  return (
    <>
      <TopBar me={publicMe(me)} appName={appName} limited={me.setupRequired} projects={canSee(me, "projects")} websites={canSee(me, "websites")} />
      <main className="container">{children}</main>
      <footer className="container muted small app-credit">{appName} · {CREDIT} · © {new Date().getFullYear()}</footer>
    </>
  );
}
