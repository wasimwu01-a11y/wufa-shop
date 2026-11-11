// Runs every day at 07:10 UTC. Starts research only when a proposal is due
// (nothing waiting for approval, and the last proposal was at least three days ago).
import { env } from "../lib/agent/config.mjs";
import { proposalDue } from "../lib/agent/pipeline.mjs";
import { startResearch } from "../lib/agent/trigger.mjs";

export default async () => {
  if (env("AGENT_PAUSED") === "1") { console.log("agent paused"); return; }
  if (!env("RESEND_API_KEY") || !env("AGENT_SECRET")) { console.log("agent not configured"); return; }
  const due = await proposalDue();
  console.log("proposal due?", JSON.stringify(due));
  if (due.due) console.log("started research:", await startResearch(false));
};

export const config = { schedule: "10 7 * * *" };
