import { redirect } from "next/navigation";
import { currentUser, type User } from "./auth";

/** For pages: signed in AND finished security setup (own password + 2FA when required). */
export async function readyUser(): Promise<User> {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.setupRequired) redirect("/account");
  return me;
}

/** Props safe to hand to client components. */
export const publicMe = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role, mfa_enabled: u.mfa_enabled, needsMfa: u.needsMfa, mfaRequired: u.mfaRequired, mustChangePassword: !!u.must_change_password });
