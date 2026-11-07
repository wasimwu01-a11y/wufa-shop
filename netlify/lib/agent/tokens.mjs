// Signed, expiring, one-time links for the email buttons.
// A link only works if it was signed with AGENT_SECRET (a long random value stored in Netlify),
// has not expired, and has not been used before.
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./config.mjs";
import { getJSON, setJSON } from "./store.mjs";

const b64 = (buf) => Buffer.from(buf).toString("base64url");

function secret() {
  const s = env("AGENT_SECRET");
  if (s.length < 32) throw new Error("AGENT_SECRET is missing or shorter than 32 characters");
  return s;
}

const sign = (body) => b64(createHmac("sha256", secret()).update(body).digest());

/** Make a token for one action on one item. */
export function makeToken(kind, id, action, ttlDays) {
  const nonce = b64(crypto.getRandomValues(new Uint8Array(12)));
  const body = b64(JSON.stringify({ k: kind, id, a: action, exp: Date.now() + ttlDays * 864e5, n: nonce }));
  return body + "." + sign(body);
}

/** Check a token. Returns its contents, or throws with a reason a person can read. */
export async function checkToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) throw new Error("This link is incomplete.");
  const want = Buffer.from(sign(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error("This link isn't valid.");
  const t = JSON.parse(Buffer.from(body, "base64url").toString());
  if (Date.now() > t.exp) throw new Error("This link has expired.");
  if (await getJSON("used/" + t.n)) throw new Error("This button has already been used.");
  return t;
}

/** Mark a token as used so it can't be pressed again. (Sibling buttons, e.g. Reject after Approve,
 *  are refused by the item's status check in the action handler.) */
export async function spendToken(t) {
  await setJSON("used/" + t.n, { at: new Date().toISOString(), kind: t.k, id: t.id, action: t.a });
}
