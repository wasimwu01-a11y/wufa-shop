// Background job: lists approved products on eBay (up to 3 per run) and emails the result of each.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { getJSON, listKeys, update } from "../lib/agent/store.mjs";
import { listProposal } from "../lib/agent/lister.mjs";
import { sendEmail, listedEmail, listFailedEmail } from "../lib/agent/email.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function runListing(max = 3) {
  const done = [];
  for (const k of await listKeys("proposal/")) {
    if (done.length >= max) break;
    const p = await getJSON(k);
    if (p?.status !== "ready_to_list") continue;
    await update(k, { status: "listing" }, "Listing started");
    try {
      const r = await listProposal(p);
      const saved = await update(k, { status: "listed", ebayListingId: r.listingId, ebayUrl: r.url }, "Listed on eBay " + r.listingId);
      await sendEmail(listedEmail(saved, r));
      done.push({ id: p.id, listed: r.listingId });
    } catch (e) {
      if (e.code === "NOT_CONNECTED") { await update(k, { status: "ready_to_list" }, "Waiting: " + e.message); done.push({ id: p.id, waiting: e.message }); break; }
      const saved = await update(k, { status: "list_failed", listError: e.message, listFix: e.fix || "" }, "Listing failed: " + e.message);
      await sendEmail(listFailedEmail(saved, e)).catch(() => {});
      done.push({ id: p.id, failed: e.message });
    }
  }
  return done;
}

export default async (req) => {
  if (req.method !== "POST" || !env("AGENT_SECRET") || !same(req.headers.get("x-agent-key") || "", env("AGENT_SECRET"))) return;
  try { console.log("listing:", JSON.stringify(await runListing())); } catch (e) { console.error("listing job failed:", e); }
};
