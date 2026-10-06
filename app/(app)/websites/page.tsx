import Websites from "@/components/Websites";
import { readyUser } from "@/lib/pageAuth";
export default async function Page() { await readyUser(); return <Websites />; }
