import Account from "@/components/Account";
import { currentUser } from "@/lib/auth";
import { publicMe } from "@/lib/pageAuth";
import { redirect } from "next/navigation";
export default async function Page() {
  const me = await currentUser();
  if (!me) redirect("/login");
  return <Account me={publicMe(me)} />;
}
