// Competitor check on eBay UK: how many fixed-price listings match, and the cheapest total (item + postage).
// Uses the eBay Browse API when the eBay keys are set; otherwise returns null and the research estimate is used.
import { ebayGet, configProblem } from "../shop.mjs";

export async function ebayCompetition(searchTerms) {
  if (configProblem()) return null;
  const q = encodeURIComponent(String(searchTerms).slice(0, 100));
  const filter = encodeURIComponent("buyingOptions:{FIXED_PRICE},itemLocationCountry:GB,deliveryCountry:GB,conditions:{NEW}");
  const r = await ebayGet(`/buy/browse/v1/item_summary/search?q=${q}&filter=${filter}&sort=price&limit=50`);
  if (!r.ok) return null;
  const items = r.body.itemSummaries || [];
  const totals = items
    .map((it) => {
      const price = parseFloat(it.price?.value);
      const ship = parseFloat(it.shippingOptions?.[0]?.shippingCost?.value ?? "0") || 0;
      return it.price?.currency === "GBP" && price > 0 ? { total: price + ship, title: it.title, url: it.itemWebUrl } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.total - b.total);
  return {
    source: "eBay API",
    count: Number(r.body.total ?? items.length),
    cheapestTotalGBP: totals[0]?.total ?? null,
    cheapest: totals.slice(0, 3),
  };
}
