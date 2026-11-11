// /agent/research-now?key=<AGENT_SECRET>  – starts a research run straight away (skips the 3-day wait,
// but still refuses if a proposal is already waiting for you). The proposal arrives by email in ~5–15 minutes.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { proposalDue } from "../lib/agent/pipeline.mjs";
import { startResearch } from "../lib/agent/trigger.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const text = (s, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export default async (req) => {
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!env("AGENT_SECRET") || !same(key, env("AGENT_SECRET"))) return text("Not found", 404);
  const missing = ["ANTHROPIC_API_KEY", "RESEND_API_KEY"].filter((k) => !env(k));
  if (missing.length) return text("Missing settings: " + missing.join(", "), 503);
  const due = await proposalDue();
  if (/in progress|waiting for you|budget/.test(due.reason)) return text("Not started: " + due.reason + ".");
  const status = await startResearch(true);
  if (status !== 202 && status !== 200) return text("Couldn't start the research job (status " + status + "). Background jobs may not be available on this Netlify plan.", 502);
  return text("Research started. A proposal email should arrive in about 5–15 minutes. If nothing suitable is found, no email is sent; check again later with /agent/status.");
};

export const config = { path: "/agent/research-now" };
