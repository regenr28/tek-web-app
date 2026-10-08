import { redirect } from "next/navigation";
import { currentUser, canSee, homeFor, accessOf, type User, type Area } from "./auth";

/** For pages: signed in AND finished security setup (own password + 2FA when required). */
export async function readyUser(): Promise<User> {
  const me = await currentUser();
  if (!me) redirect("/login");
  if (me.setupRequired) redirect("/account");
  return me;
}

/** For pages inside an area (Projects / All Websites): sends people without access to the area they can see. */
export async function areaUser(area: Area): Promise<User> {
  const me = await readyUser();
  if (!canSee(me, area)) redirect(homeFor(me));
  return me;
}

/** Props safe to hand to client components. */
export const publicMe = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role, mfa_enabled: u.mfa_enabled, needsMfa: u.needsMfa, mfaRequired: u.mfaRequired, mustChangePassword: !!u.must_change_password, access: accessOf(u) });
