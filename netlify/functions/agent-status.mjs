// /agent/status?key=<AGENT_SECRET>  – plain-text summary of what the agent is doing.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { getJSON, listKeys } from "../lib/agent/store.mjs";
import { proposalDue, dailyBudget } from "../lib/agent/pipeline.mjs";

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
    "Settings: " + ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "EBAY_CLIENT_ID"].map((k) => k + (env(k) ? " ✓" : " ✗")).join(", "),
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
  lines.push("", "Proposals:");
  for (const k of await listKeys("proposal/")) {
    if (k.startsWith("proposal/TEST-")) continue;
    const p = await getJSON(k);
    lines.push(`  ${p.createdAt?.slice(0, 10) || ""}  ${p.status.padEnd(22)} ${p.title}`);
  }
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
};

export const config = { path: "/agent/status" };
