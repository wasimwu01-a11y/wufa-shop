// Promoted Listings (Standard, pay-per-sale) for the agent's eBay listings, at a break-even ad rate:
// the ad fee on a sale equals the profit on that sale, so a promoted sale makes £0 but builds sales
// history and visibility. Each listing is promoted for AGENT_PROMOTE_DAYS (30) and then the ad is removed.
// eBay Marketing API: https://developer.ebay.com/api-docs/sell/marketing/resources/methods
import { env } from "./config.mjs";
import { getJSON, setJSON, getAll } from "./store.mjs";
import { sell, ebayErrors, sellerStatus } from "./ebayuser.mjs";

const M = "/sell/marketing/v1";
const CAMPAIGN_KEY = "agent/promo-campaign";
const NAME = () => env("AGENT_PROMOTE_CAMPAIGN", "Wufa agent – break-even (auto)");
const MIN_RATE = 2.0; // eBay's minimum ad rate for Promoted Listings Standard
const days = () => Number(env("AGENT_PROMOTE_DAYS", "30"));
export const promotionOn = () => env("AGENT_PROMOTE", "1") !== "0";

/**
 * Break-even ad rate (%): profit ÷ (price × VAT on eBay fees). eBay charges the ad rate on the total sale
 * (item + postage; postage is free here so that's the price). Rounded down to 0.1 so the fee never exceeds the profit.
 */
export function breakEvenRate(pricePence, profitPence) {
  const vat = Number(env("EBAY_FEES_VAT", "1.2"));
  if (!(pricePence > 0) || !(profitPence > 0)) return 0;
  return Math.min(100, Math.floor((profitPence / (pricePence * vat)) * 1000) / 10);
}

const idFrom = (loc) => String(loc || "").split("/").filter(Boolean).pop();

async function campaignId() {
  const saved = await getJSON(CAMPAIGN_KEY);
  if (saved?.id) return saved.id;
  const found = await sell("GET", `${M}/ad_campaign/get_campaign_by_name?campaign_name=` + encodeURIComponent(NAME()));
  let id = found.ok ? found.body?.campaignId : null;
  if (!id) {
    const c = await sell("POST", `${M}/ad_campaign`, {
      campaignName: NAME(), marketplaceId: "EBAY_GB", startDate: new Date(Date.now() + 60e3).toISOString(),
      fundingStrategy: { fundingModel: "COST_PER_SALE", bidPercentage: "2.0" },
    });
    if (!c.ok) throw new Error("couldn't create the Promoted Listings campaign: " + ebayErrors(c));
    id = c.body?.campaignId || idFrom(c.location);
  }
  if (!id) throw new Error("eBay didn't return a campaign id");
  await setJSON(CAMPAIGN_KEY, { id, name: NAME(), at: new Date().toISOString() });
  return id;
}

/** Profit and price for a listing (from the listing record, or the proposal it came from). */
async function economics(L) {
  if (L.profitPence != null) return { price: L.pricePence, profit: L.profitPence };
  const p = L.proposalId ? await getJSON("proposal/" + L.proposalId) : null;
  return { price: L.pricePence ?? p?.pricing?.pricePence, profit: p?.pricing?.profitPence };
}

/** Starts the break-even ad for one agent listing. Returns { rate, adId } or { skipped }. */
export async function promote(key, L) {
  const { price, profit } = await economics(L);
  const rate = breakEvenRate(price, profit);
  if (rate < MIN_RATE) {
    await setJSON(key, { ...L, promo: { status: "skipped", reason: `break-even rate ${rate}% is below eBay's ${MIN_RATE}% minimum`, at: new Date().toISOString() } });
    return { skipped: `rate ${rate}% below minimum` };
  }
  const cid = await campaignId();
  const bid = rate.toFixed(1);
  let r = await sell("POST", `${M}/ad_campaign/${cid}/ad`, { listingId: L.listingId, bidPercentage: bid });
  let adId = r.ok ? (r.body?.adId || idFrom(r.location)) : null;
  if (!r.ok) {
    // Already in the campaign (e.g. a retry): find it and set the rate.
    const g = await sell("GET", `${M}/ad_campaign/${cid}/get_ads_by_listing_id?listing_id=` + encodeURIComponent(L.listingId));
    adId = g.ok ? g.body?.ads?.[0]?.adId : null;
    if (!adId) {
      if (r.status === 404 || /campaign/i.test(ebayErrors(r))) await setJSON(CAMPAIGN_KEY, {}); // campaign gone – recreate next time
      throw new Error("eBay refused the promotion: " + ebayErrors(r));
    }
    await sell("POST", `${M}/ad_campaign/${cid}/ad/${adId}/update_bid`, { bidPercentage: bid });
  }
  const now = Date.now();
  await setJSON(key, { ...L, promo: { status: "on", rate, adId, campaignId: cid, since: new Date(now).toISOString(), until: new Date(now + days() * 864e5).toISOString() } });
  return { rate, adId };
}

/** Removes the ad once its promotion period is over. */
async function endPromotion(key, L) {
  const r = await sell("DELETE", `${M}/ad_campaign/${L.promo.campaignId}/ad/${L.promo.adId}`);
  if (!r.ok && r.status !== 404) throw new Error("couldn't remove the ad: " + ebayErrors(r));
  await setJSON(key, { ...L, promo: { ...L.promo, status: "ended", endedAt: new Date().toISOString() } });
}

/** Daily: promote new agent listings, end promotions older than the promotion period. */
export async function sweepPromotions() {
  const out = { started: [], ended: [], skipped: [], errors: [], blocked: null };
  if (!promotionOn()) return { ...out, blocked: "AGENT_PROMOTE=0" };
  const st = await sellerStatus().catch(() => ({}));
  if (!st.connected) return { ...out, blocked: "eBay not connected" };
  if (!st.canPromote) return { ...out, blocked: "reconnect eBay to allow Promoted Listings (/agent/ebay-connect)" };
  for (const { k, v: L } of await getAll("listing/")) {
    if (!L.dropship) continue;
    try {
      if (!L.promo || L.promo.status === "error") {
        const r = await promote(k, L);
        (r.skipped ? out.skipped : out.started).push({ listingId: L.listingId, ...r });
      } else if (L.promo.status === "on" && Date.now() > Date.parse(L.promo.until)) {
        await endPromotion(k, L); out.ended.push(L.listingId);
      }
    } catch (e) {
      out.errors.push({ listingId: L.listingId, error: String(e.message || e) });
      await setJSON(k, { ...L, promo: { status: "error", error: String(e.message || e), at: new Date().toISOString() } });
    }
  }
  return out;
}
