import Dashboard from "@/components/Dashboard";
import { areaUser } from "@/lib/pageAuth";
export default async function Page() { await areaUser("projects"); return <Dashboard />; }
