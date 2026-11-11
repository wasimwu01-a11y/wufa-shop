// Runs every day at 07:10 UTC. Starts research only when a proposal is due
// (nothing waiting for approval, and the last proposal was at least three days ago).
import { env } from "../lib/agent/config.mjs";
import { proposalDue } from "../lib/agent/pipeline.mjs";
import { startResearch, startListing } from "../lib/agent/trigger.mjs";
import { getJSON, setJSON, listKeys } from "../lib/agent/store.mjs";
import { sellerStatus } from "../lib/agent/ebayuser.mjs";
import { sendEmail, reconnectEmail } from "../lib/agent/email.mjs";

export default async () => {
  if (env("AGENT_PAUSED") === "1") { console.log("agent paused"); return; }
  if (!env("RESEND_API_KEY") || !env("AGENT_SECRET")) { console.log("agent not configured"); return; }
  // Anything approved but not yet listed (e.g. a failed background job) gets another go.
  for (const k of await listKeys("proposal/")) { if ((await getJSON(k))?.status === "ready_to_list") { console.log("listing job:", await startListing()); break; } }
  // Remind about reconnecting eBay ~2 weeks before the access expires (weekly).
  const s = await sellerStatus().catch(() => ({}));
  const meta = (await getJSON("meta/agent")) || {};
  if (s.connected && Date.parse(s.refreshExpires) - Date.now() < 14 * 864e5 && Date.now() - Date.parse(meta.reconnectRemindedAt || 0) > 7 * 864e5) {
    await sendEmail(reconnectEmail(s.refreshExpires)); await setJSON("meta/agent", { ...meta, reconnectRemindedAt: new Date().toISOString() });
  }
  const due = await proposalDue();
  console.log("proposal due?", JSON.stringify(due));
  if (due.due) console.log("started research:", await startResearch(false));
};

export const config = { schedule: "10 7 * * *" };
