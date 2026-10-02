import Dashboard from "@/components/Dashboard";
import { readyUser } from "@/lib/pageAuth";
export default async function Page() { await readyUser(); return <Dashboard />; }
