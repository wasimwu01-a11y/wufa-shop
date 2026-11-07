// Background job (up to 15 minutes): runs one research cycle.
// Only starts when called with the agent secret (by the daily schedule or the manual trigger).
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { runCycle } from "../lib/agent/pipeline.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export default async (req) => {
  if (req.method !== "POST" || !env("AGENT_SECRET") || !same(req.headers.get("x-agent-key") || "", env("AGENT_SECRET"))) return;
  const body = await req.json().catch(() => ({}));
  try {
    const r = await runCycle({ force: !!body.force });
    console.log("research cycle:", JSON.stringify(r));
  } catch (e) {
    console.error("research cycle failed:", e);
  }
};
