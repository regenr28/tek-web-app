import Websites from "@/components/Websites";
import { areaUser } from "@/lib/pageAuth";
export default async function Page() { await areaUser("websites"); return <Websites />; }
