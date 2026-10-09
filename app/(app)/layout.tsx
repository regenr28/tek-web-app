import { redirect } from "next/navigation";
import { currentUser, canSee } from "@/lib/auth";
import { publicMe } from "@/lib/pageAuth";
import TopBar from "@/components/TopBar";
import { CREDIT } from "@/lib/credit";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await currentUser();
  if (!me) redirect("/login");
  return (
    <>
      <TopBar me={publicMe(me)} limited={me.setupRequired} projects={canSee(me, "projects")} websites={canSee(me, "websites")} />
      <main className="container">{children}</main>
      <footer className="container muted small app-credit">Duda Preview Audit · {CREDIT} · © {new Date().getFullYear()}</footer>
    </>
  );
}
