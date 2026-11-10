import { describe, expect, it } from "vitest";
import { signedInUser } from "../src/auto-identify.ts";

/** A page window with its own storage (Node's built-in localStorage would shadow the test browser's). */
function page(items: Record<string, string>, extra: Record<string, unknown> = {}): Window {
  const keys = Object.keys(items);
  const localStorage = { get length() { return keys.length; }, key: (i: number) => keys[i] ?? null, getItem: (k: string) => items[k] ?? null } as Storage;
  return { localStorage, ...extra } as unknown as Window;
}

describe("recognising the signed-in user from the site's sign-in tool", () => {
  it("Supabase: the user id from its stored session, nothing else", () => {
    const win = page({ "sb-abcdefghijklmnopqrst-auth-token": JSON.stringify({ access_token: "secret.jwt.token", user: { id: "4f93e1fc-3cd2-4c1a-bc76-1234567b3ddf", email: "someone@example.com" } }) });
    expect(signedInUser(win)).toBe("4f93e1fc-3cd2-4c1a-bc76-1234567b3ddf");
  });

  it("Clerk: the signed-in user's id", () => {
    expect(signedInUser(page({}, { Clerk: { user: { id: "user_2abc", primaryEmailAddress: "x@y.com" } } }))).toBe("user_2abc");
  });

  it("Auth0 (local storage cache): the user's subject id", () => {
    const win = page({ "@@auth0spajs@@::clientid::@@user@@": JSON.stringify({ id_token: "t", decodedToken: { user: { sub: "google-oauth2|1234567890", email: "a@b.com" } } }) });
    expect(signedInUser(win)).toBe("google-oauth2|1234567890");
  });

  it("Firebase (local persistence): the uid", () => {
    const win = page({ "firebase:authUser:AIzaKey:[DEFAULT]": JSON.stringify({ uid: "kXq9", email: "a@b.com", stsTokenManager: { accessToken: "t" } }) });
    expect(signedInUser(win)).toBe("kXq9");
  });

  it("never uses an id that is an email address, or anything it can't read", () => {
    const win = page({ "sb-abc-auth-token": "not json", "firebase:authUser:k:[DEFAULT]": JSON.stringify({ uid: "x".repeat(200) }) }, { Clerk: { user: { id: "someone@example.com" } } });
    expect(signedInUser(win)).toBeUndefined();
  });

  it("nobody signed in: nothing", () => {
    expect(signedInUser(page({ theme: "dark" }))).toBeUndefined();
    expect(signedInUser(page({}, { Clerk: { user: null } }))).toBeUndefined();
  });

  it("storage the page won't let us read: nothing, and no error", () => {
    const win = { get localStorage(): Storage { throw new Error("blocked"); } } as unknown as Window;
    expect(signedInUser(win)).toBeUndefined();
  });
});
