import Settings from "@/components/Settings";
import { readyUser, publicMe } from "@/lib/pageAuth";
import { dudaEnabled } from "@/lib/duda";
export default async function Page() {
  const me = await readyUser();
  return <Settings me={publicMe(me)} dudaApi={dudaEnabled()} />;
}
