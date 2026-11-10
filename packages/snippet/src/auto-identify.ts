/**
 * Who is signed in, when the site uses a common sign-in tool and doesn't tell us itself. Reads
 * only the user's id from where the tool keeps it in the page: never a token, an email or any
 * other field. Turned off with `autoIdentify: false`, and never used once the site passes a
 * userId or calls identify itself.
 *
 *   Supabase  localStorage "sb-<project>-auth-token"      → user.id
 *   Clerk     window.Clerk.user                            → id
 *   Auth0     localStorage "@@auth0spajs@@::…::@@user@@"   → decodedToken.user.sub (cacheLocation "localstorage")
 *   Firebase  localStorage "firebase:authUser:…"           → uid (local persistence)
 *
 * An id that looks like an email address is never used: some setups use the email as the id.
 */
export function signedInUser(win: Window): string | undefined {
  const fromClerk = (win as unknown as { Clerk?: { user?: { id?: unknown } | null } }).Clerk?.user?.id;
  if (usable(fromClerk)) return fromClerk;
  let storage: Storage;
  try {
    storage = win.localStorage;
  } catch {
    return undefined;
  }
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i) ?? "";
    let read: unknown;
    if (/^sb-[a-z0-9]+-auth-token$/.test(key)) read = (o: Record<string, any>) => o?.user?.id ?? o?.currentSession?.user?.id;
    else if (key.startsWith("@@auth0spajs@@::") && key.endsWith("::@@user@@")) read = (o: Record<string, any>) => o?.decodedToken?.user?.sub;
    else if (key.startsWith("firebase:authUser:")) read = (o: Record<string, any>) => o?.uid;
    else continue;
    try {
      const id = (read as (o: unknown) => unknown)(JSON.parse(storage.getItem(key) ?? "null"));
      if (usable(id)) return id;
    } catch {
      // Not the shape we know: leave it.
    }
  }
  return undefined;
}

const usable = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 128 && !id.includes("@") && !/[\u0000-\u001f]/.test(id);
