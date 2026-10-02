import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { publicMe } from "@/lib/pageAuth";
import TopBar from "@/components/TopBar";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await currentUser();
  if (!me) redirect("/login");
  return (
    <>
      <TopBar me={publicMe(me)} limited={me.setupRequired} />
      <main className="container">{children}</main>
    </>
  );
}
