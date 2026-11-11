// Seller access to Wufa's eBay account (OAuth "authorization code" grant).
// You sign in to eBay once; eBay gives a refresh token (valid ~18 months) that is stored in Netlify Blobs
// (readable only by these functions) and used to get short-lived access tokens for listing.
import { env, siteUrl } from "./config.mjs";
import { getJSON, setJSON } from "./store.mjs";
import { makeToken, checkToken, spendToken } from "./tokens.mjs";

const API = () => env("EBAY_API_BASE", "https://api.ebay.com");
const AUTH = () => env("EBAY_AUTH_BASE", "https://auth.ebay.com");
export const SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
];
const KEY = "secret/ebay-seller";
let cache = { token: null, exp: 0 };

const basic = () => "Basic " + Buffer.from(env("EBAY_CLIENT_ID") + ":" + env("EBAY_CLIENT_SECRET")).toString("base64");

export function connectProblem() {
  const m = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_RUNAME", "AGENT_SECRET"].filter((k) => !env(k));
  return m.length ? "Missing settings: " + m.join(", ") : null;
}

/** URL that sends you to eBay to approve selling access. `state` is a signed one-time token. */
export function authorizeUrl() {
  const state = makeToken("ebay", "connect", "connect", 1);
  const q = new URLSearchParams({ client_id: env("EBAY_CLIENT_ID"), response_type: "code", redirect_uri: env("EBAY_RUNAME"), scope: SCOPES.join(" "), state });
  return AUTH() + "/oauth2/authorize?" + q.toString();
}

/** Handles eBay's redirect back: checks state, swaps the code for tokens, stores the refresh token. */
export async function completeConnect(code, state) {
  const t = await checkToken(state);
  if (t.k !== "ebay") throw new Error("This sign-in link isn't valid.");
  const res = await fetch(API() + "/identity/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: env("EBAY_RUNAME") }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.refresh_token) throw new Error("eBay didn't accept the sign-in (" + res.status + "): " + JSON.stringify(j).slice(0, 200));
  await spendToken(t);
  const exp = Date.now() + (Number(j.refresh_token_expires_in) || 47304000) * 1000;
  await setJSON(KEY, { refreshToken: j.refresh_token, refreshExpires: new Date(exp).toISOString(), connectedAt: new Date().toISOString() });
  cache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 7200) - 120) * 1000 };
  return { refreshExpires: new Date(exp).toISOString() };
}

export async function sellerStatus() {
  const s = await getJSON(KEY);
  return s ? { connected: true, connectedAt: s.connectedAt, refreshExpires: s.refreshExpires } : { connected: false };
}

async function userToken() {
  if (cache.token && Date.now() < cache.exp) return cache.token;
  const s = await getJSON(KEY);
  if (!s?.refreshToken) throw Object.assign(new Error("eBay selling access isn't connected yet – open /agent/ebay-connect"), { code: "NOT_CONNECTED" });
  const res = await fetch(API() + "/identity/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refreshToken, scope: SCOPES.join(" ") }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error("eBay refused the stored sign-in (" + res.status + ") – reconnect at /agent/ebay-connect"), { code: "NOT_CONNECTED" });
  cache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 7200) - 120) * 1000 };
  return cache.token;
}

/** Calls a Sell API as Wufa. Returns { ok, status, body }. */
export async function sell(method, path, body) {
  const res = await fetch(API() + path, {
    method,
    headers: {
      Authorization: "Bearer " + (await userToken()),
      "Content-Type": "application/json",
      "Content-Language": "en-GB",
      "Accept-Language": "en-GB",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, body: j };
}

export const ebayErrors = (r) => (r.body?.errors || []).map((e) => e.longMessage || e.message).filter(Boolean).join(" | ") || "HTTP " + r.status;
export { siteUrl };
