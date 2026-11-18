// Background job: lists approved products on eBay (up to 3 per run) and emails the result of each.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { getJSON, listKeys, update } from "../lib/agent/store.mjs";
import { listProposal } from "../lib/agent/lister.mjs";
import { promote, promotionOn } from "../lib/agent/promote.mjs";
import { betterDescription } from "../lib/agent/writer.mjs";
import { blocks as descBlocks } from "../lib/agent/describe.mjs";
import { sellerStatus } from "../lib/agent/ebayuser.mjs";
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
      // New listings get a Claude-written description from the supplier's facts (falls back to the supplier's own text).
      if (!p.revise && !p.reviseQuiet && !p.aiDescription && p.queueKey && env("AGENT_AI_WRITING", "1") !== "0") {
        const q = await getJSON(p.queueKey);
        const nd = q ? await betterDescription({ title: p.listingTitle || p.title, supplierText: descBlocks(q.descriptionHtml || q.description).map((b) => b.p || (b.ul || []).join(". ")).join("\n"), facts: [q.material, q.dimensions].filter(Boolean).join(". ") }).catch(() => null) : null;
        if (nd) Object.assign(p, await update(k, { aiDescription: nd }, "Description written by Claude"));
      }
      const r = await listProposal(p);
      const saved = await update(k, { status: "listed", ebayListingId: r.listingId, ebayUrl: r.url }, "Listed on eBay " + r.listingId);
      // Break-even Promoted Listings ad for new listings (best effort – the daily run retries).
      if (promotionOn() && !saved.revise) {
        const LK = "listing/" + r.listingId, L = await getJSON(LK);
        if (L && !L.promo) {
          const st = await sellerStatus().catch(() => ({}));
          if (!st.canPromote) r.promo = { blocked: true };
          else r.promo = await promote(LK, L).catch((e) => ({ error: String(e.message || e) }));
        }
      }
      if (!saved.reviseQuiet) await sendEmail(listedEmail(saved, r)); // the weekly learning email covers the agent's own improvements
      if (saved.revise || saved.reviseQuiet) await update(k, { revise: false, reviseQuiet: false }, "Update sent to eBay");
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
