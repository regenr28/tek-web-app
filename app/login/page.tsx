import { getAppName } from "@/lib/branding";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  return <LoginForm appName={await getAppName()} />;
}
