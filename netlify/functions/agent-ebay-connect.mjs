// /agent/ebay-connect?key=<AGENT_SECRET>  → sends you to eBay to approve selling access for the agent.
// /agent/ebay-callback?code=…&state=…    → eBay sends you back here; the agent stores the access.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { authorizeUrl, completeConnect, connectProblem, sellerStatus } from "../lib/agent/ebayuser.mjs";
import { esc } from "../lib/agent/email.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#fafaf8;color:#1d1d1b;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}@media (prefers-color-scheme:dark){body{background:#161614;color:#f2f0eb}}.w{max-width:560px;margin:0 auto;padding:40px 16px}a.b{display:inline-block;padding:12px 20px;border-radius:8px;background:#c8372d;color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><div class="w"><h1 style="font-size:1.3rem">${esc(title)}</h1>${body}</div></body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

export default async (req) => {
  const u = new URL(req.url);
  if (u.pathname.endsWith("/ebay-callback")) {
    const code = u.searchParams.get("code"), state = u.searchParams.get("state");
    if (!code || !state) return page("eBay sign-in cancelled", "<p>No changes were made. You can try again from your connect link.</p>", 400);
    try {
      const r = await completeConnect(code, state);
      return page("eBay selling access connected", `<p>The agent can now create listings on your eBay account. This access lasts until about <b>${esc(r.refreshExpires.slice(0, 10))}</b>; the agent will email you before then to reconnect.</p><p>You can revoke it any time in eBay: Account settings → Third-party app permissions.</p>`);
    } catch (e) {
      return page("Couldn't connect eBay", `<p>${esc(e.message)}</p><p>Please try your connect link again.</p>`, 400);
    }
  }
  const key = u.searchParams.get("key") || "";
  if (!env("AGENT_SECRET") || !same(key, env("AGENT_SECRET"))) return new Response("Not found", { status: 404 });
  const problem = connectProblem();
  if (problem) return page("Not ready yet", `<p>${esc(problem)}. Add it in Netlify → Environment variables, redeploy, then reopen this link.</p>`, 503);
  const s = await sellerStatus();
  return page("Connect eBay selling access", `${s.connected ? `<p>Already connected since ${esc(s.connectedAt.slice(0, 10))} (valid until ${esc(s.refreshExpires.slice(0, 10))}). Reconnect only if listing stops working.</p>` : ""}
<p>You'll go to eBay, sign in as <b>nuvr_61</b> and approve access for listing items, managing postage/returns policies and reading orders. Nothing is listed without your approval email.</p>
<p><a class="b" href="${esc(authorizeUrl())}">Continue to eBay</a></p>`);
};

export const config = { path: ["/agent/ebay-connect", "/agent/ebay-callback"] };
