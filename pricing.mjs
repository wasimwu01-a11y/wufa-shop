// Pricing rule: price = (supplier cost incl. VAT + supplier delivery + fixed fees + £1.50) / (1 - fee rate),
// rounded UP to the next 9p ending, then checked against the cheapest comparable eBay listing.
import { MIN_PROFIT_GBP } from "./config.mjs";

const pence = (gbp) => Math.round(Number(gbp) * 100);

// Round up to the next price ending in 9p: 1356 -> 1359, 1359 -> 1359, 1360 -> 1369.
export function roundUpTo9(p) {
  return p + (9 - (p % 10));
}

/**
 * @param {object} o
 * @param {number} o.supplierCost      item cost in GBP including VAT
 * @param {number} [o.supplierDelivery] supplier's delivery charge in GBP (incl. VAT)
 * @param {number} o.feeRate           marketplace % fee as a fraction, e.g. 0.128
 * @param {number} [o.fixedFee]        fixed per-order fee in GBP, e.g. 0.30
 * @param {number} [o.minProfit]       profit floor in GBP (default £1.50)
 * @param {number|null} [o.cheapestCompetitor] lowest comparable eBay price incl. postage, GBP
 */
export function priceItem(o) {
  const cost = pence(o.supplierCost) + pence(o.supplierDelivery || 0);
  const fixed = pence(o.fixedFee || 0);
  const floor = pence(o.minProfit ?? MIN_PROFIT_GBP);
  const rate = Number(o.feeRate);
  if (!(cost > 0) || !(rate >= 0 && rate < 0.5)) throw new Error("Invalid cost or fee rate");

  const raw = Math.ceil((cost + fixed + floor) / (1 - rate));
  const price = roundUpTo9(raw);
  const fees = Math.ceil(price * rate) + fixed;
  const profit = price - fees - cost;
  const competitor = o.cheapestCompetitor != null ? pence(o.cheapestCompetitor) : null;

  const reasons = [];
  if (profit < floor) reasons.push(`profit £${(profit / 100).toFixed(2)} is below £${(floor / 100).toFixed(2)}`);
  if (competitor != null && price > competitor)
    reasons.push(`price £${(price / 100).toFixed(2)} is above the cheapest competitor at £${(competitor / 100).toFixed(2)}`);

  return {
    pricePence: price,
    costPence: cost,
    feesPence: fees,
    profitPence: profit,
    competitorPence: competitor,
    ok: reasons.length === 0,
    reasons,
  };
}

export const gbp = (p) => "£" + (p / 100).toFixed(2);
