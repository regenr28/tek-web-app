import { notFound } from "next/navigation";
import SiteView from "@/components/SiteView";
import { readyUser, publicMe } from "@/lib/pageAuth";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) notFound();
  const me = await readyUser();
  return <SiteView id={Number(id)} me={publicMe(me)} />;
}
