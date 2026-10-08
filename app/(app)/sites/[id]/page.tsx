import { notFound } from "next/navigation";
import SiteView from "@/components/SiteView";
import { areaUser, publicMe } from "@/lib/pageAuth";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) notFound();
  const me = await areaUser("projects");
  return <SiteView id={Number(id)} me={publicMe(me)} />;
}
