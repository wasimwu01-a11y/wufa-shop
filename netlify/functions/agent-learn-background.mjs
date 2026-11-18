// Weekly learning run (background, up to 15 min): collects eBay traffic, sales and market data, updates what
// the agent has learned, improves or ends listings, and emails you a report with Undo buttons.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { learnRun } from "../lib/agent/learn.mjs";
import { sendEmail, learnEmail } from "../lib/agent/email.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export default async (req) => {
  if (req.method !== "POST" || !env("AGENT_SECRET") || !same(req.headers.get("x-agent-key") || "", env("AGENT_SECRET"))) return;
  let force = false; try { force = !!(await req.json()).force; } catch {}
  try {
    const r = await learnRun({ force });
    if (r.skipped) { console.log("learning:", r.skipped); return; }
    await sendEmail(learnEmail(r));
    console.log("learning:", JSON.stringify({ changes: r.run.changes.length, errors: r.run.errors }));
  } catch (e) { console.error("learning run failed:", e); }
};
