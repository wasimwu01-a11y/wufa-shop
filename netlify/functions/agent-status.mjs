// /agent/status?key=<AGENT_SECRET>  – plain-text summary of what the agent is doing.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { getJSON, listKeys, getAll } from "../lib/agent/store.mjs";
import { proposalDue, dailyBudget } from "../lib/agent/pipeline.mjs";
import { sellerStatus } from "../lib/agent/ebayuser.mjs";
import { cjStatus } from "../lib/agent/cj.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export default async (req) => {
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!env("AGENT_SECRET") || !same(key, env("AGENT_SECRET"))) return new Response("Not found", { status: 404 });
  const meta = (await getJSON("meta/agent")) || {};
  const due = await proposalDue();
  const lines = [
    "Wufa agent status – " + new Date().toUTCString(),
    "",
    "Settings: " + ["RESEND_API_KEY", "EBAY_CLIENT_ID", "ANTHROPIC_API_KEY"].map((k) => k + (env(k) ? " ✓" : " ✗")).join(", "),
    "Paused: " + (env("AGENT_PAUSED") === "1" ? "yes" : "no"),
    "Next proposal due: " + (due.due ? "yes (next daily run at 07:10 UTC)" : "no – " + due.reason),
    "Research running: " + (meta.running ? "since " + meta.running : "no"),
    "Last proposal: " + (meta.lastProposalAt || "none yet"),
    "Research spend today: $" + (meta.spend?.date === new Date().toISOString().slice(0, 10) ? meta.spend.usd.toFixed(2) : "0.00") + " of $" + dailyBudget().toFixed(2) + " daily budget",
  ];
  if (meta.lastRun) {
    lines.push("", "Last run: " + meta.lastRun.at + (meta.lastRun.error ? "  ERROR: " + meta.lastRun.error : ""));
    for (const a of meta.lastRun.attempts || []) lines.push("  - " + (a.title || "(nothing found)") + ": " + (a.ok ? "passed" : a.reasons.join("; ")));
  }
  const qc = {};
  for (const { v: q } of await getAll("queue/")) qc[q.status] = (qc[q.status] || 0) + 1;
  lines.push("", "Listing queue: " + (Object.keys(qc).length ? Object.entries(qc).map(([k, v]) => v + " " + k.replace(/_/g, " ")).join(", ") : "empty – add products with /agent/screener"));
  const st = (await getJSON("agent/settings"))?.status;
  lines.push("Internet research: " + (env("AGENT_AI_RESEARCH") === "1" ? "on (Netlify setting)" : st === "research_on" ? "on (you allowed it by email)" : st === "awaiting_choice" ? "off – waiting for your choice (email sent)" : "off"));
  const ss = await sellerStatus().catch(() => ({ connected: false }));
  lines.push("eBay selling access: " + (ss.connected ? "connected (valid until " + ss.refreshExpires.slice(0, 10) + ")" : "NOT connected – open /agent/ebay-connect"));
  const listings = await getAll("listing/");
  lines.push("Agent listings on eBay: " + listings.length);
  const lrn = await getJSON("agent/learn");
  lines.push("Learning: " + (lrn?.lastRunAt ? "last run " + lrn.lastRunAt.slice(0, 16) + " – " + (lrn.lastRun?.changes?.length || 0) + " changes" + (lrn.insights ? "; " + lrn.insights : "; not enough data yet") : "first run at the next daily run") + (ss.connected && !ss.canAnalyse ? " (traffic data needs one eBay reconnect)" : ""));
  if (ss.connected && !ss.canPromote) lines.push("Promoted Listings: needs one reconnect – open /agent/ebay-connect?key=… and sign in again (adds the marketing permission)");
  for (const { v: L } of listings) if (L.promo) lines.push("  - " + L.listingId + ": promotion " + L.promo.status + (L.promo.rate ? " at " + L.promo.rate + "%" : "") + (L.promo.until ? " until " + L.promo.until.slice(0, 10) : "") + (L.promo.reason || L.promo.error ? " – " + (L.promo.reason || L.promo.error) : ""));
  const cs = await cjStatus().catch(() => null);
  if (cs) lines.push("CJ Dropshipping: " + (cs.connected ? "API key set" : "NOT set (CJ_API_KEY)") + "; " + cs.inQueue + " CJ products in queue" + (cs.state?.lastRun ? "; last import " + cs.state.lastRun.at.slice(0, 16) + " – checked " + cs.state.lastRun.checked + ", queued " + cs.state.lastRun.queued.length + (cs.state.lastRun.error ? " (stopped: " + cs.state.lastRun.error + ")" : "") : ""));
  lines.push("", "Proposals:");
  for (const { k, v: p } of await getAll("proposal/")) {
    if (k.startsWith("proposal/TEST-")) continue;
    lines.push(`  ${p.createdAt?.slice(0, 10) || ""}  ${p.status.padEnd(22)} ${p.title}`);
  }
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
};

export const config = { path: "/agent/status" };
