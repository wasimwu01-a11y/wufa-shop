// Competitor check on eBay UK: how many fixed-price listings match, and the cheapest total (item + postage).
// Uses the eBay Browse API when the eBay keys are set; otherwise returns null and the research estimate is used.
import { ebayGet, configProblem, env } from "../shop.mjs";

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

// ---------- Matching a supplier product to eBay competitors ----------
const STOP = new Set(["the", "and", "with", "for", "set", "pack", "piece", "pieces", "approx", "large", "small", "medium", "mini", "new", "gift", "uk", "cm", "mm", "x"]);
const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));

export const ebaySearchUrl = (name) =>
  "https://www.ebay.co.uk/sch/i.html?_nkw=" + encodeURIComponent(tokens(name).slice(0, 8).join(" ")) + "&LH_BIN=1&LH_ItemCondition=1000&LH_PrefLoc=1&_sop=15";

function totalOf(it) {
  const price = parseFloat(it.price?.value);
  const ship = parseFloat(it.shippingOptions?.[0]?.shippingCost?.value ?? "0") || 0;
  return it.price?.currency === "GBP" && price > 0 ? Math.round((price + ship) * 100) / 100 : null;
}

/**
 * Finds comparable eBay UK listings (new, Buy It Now, UK-located) for a product:
 * exact barcode (GTIN) matches plus keyword matches whose titles share most of the product's words.
 * Returns { checked, count, cheapest, top:[{title,total,url}], searchUrl } or { checked:false } if eBay isn't connected.
 */
export async function ebayMatch({ name, barcode, minOverlap = 0.6 }) {
  if (configProblem()) return { checked: false, reason: "eBay keys not connected" };
  const filter = encodeURIComponent("buyingOptions:{FIXED_PRICE},itemLocationCountry:GB,deliveryCountry:GB,conditions:{NEW}");
  const own = (env("EBAY_SELLER", "nuvr_61") || "").toLowerCase();
  const want = tokens(name);
  const seen = new Map();
  const add = (it, how) => {
    if (!it || seen.has(it.itemId) || (it.seller?.username || "").toLowerCase() === own) return;
    const total = totalOf(it);
    if (total == null) return;
    seen.set(it.itemId, { title: it.title, total, url: it.itemWebUrl, how });
  };
  const gtin = String(barcode || "").replace(/\D/g, "");
  const calls = [];
  let failed = 0, kwFailed = false;
  const key = want.slice(0, 8);
  if (gtin.length >= 8 && gtin.length <= 14) calls.push(ebayGet(`/buy/browse/v1/item_summary/search?gtin=${gtin}&filter=${filter}&limit=50`).then((r) => { if (!r.ok) { failed++; return; } (r.body.itemSummaries || []).forEach((it) => add(it, "barcode")); }));
  if (want.length) calls.push(ebayGet(`/buy/browse/v1/item_summary/search?q=${encodeURIComponent(want.slice(0, 5).join(" "))}&filter=${filter}&limit=50`).then((r) => {
    if (!r.ok) { failed++; kwFailed = true; return; }
    for (const it of r.body.itemSummaries || []) {
      const t = new Set(tokens(it.title));
      const overlap = key.filter((w) => t.has(w)).length / key.length;
      if (overlap >= minOverlap) add(it, "title");
    }
  }));
  await Promise.all(calls);
  if (kwFailed || (failed && failed === calls.length)) return { checked: false, reason: "eBay search failed – try again later" };
  const list = [...seen.values()].sort((a, b) => a.total - b.total);
  return { checked: true, count: list.length, cheapest: list[0]?.total ?? null, top: list.slice(0, 3), searchUrl: ebaySearchUrl(name) };
}
