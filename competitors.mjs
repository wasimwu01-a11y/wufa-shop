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

// ---------- Demand: how much similar listings actually sell ----------
/**
 * Finds similar new UK Buy It Now listings and reads eBay's "sold" count on each (Browse getItem →
 * estimatedSoldQuantity) plus when it was listed, to estimate sales per month across those listings.
 * Returns { checked, listings, sold, perMonth, top:[{title,sold,perMonth,url}], searchUrl } or { checked:false, reason, rateLimited }.
 */
export async function ebayDemand({ name, barcode, maxListings = 6, minOverlap = 0.6 }) {
  if (configProblem()) return { checked: false, reason: "eBay keys not connected" };
  const filter = encodeURIComponent("buyingOptions:{FIXED_PRICE},itemLocationCountry:GB,conditions:{NEW}");
  const own = (env("EBAY_SELLER", "nuvr_61") || "").toLowerCase();
  const want = tokens(name), key = want.slice(0, 8);
  const cands = new Map(); // legacy listing id -> item id
  const legacy = (id) => String(id).split("|")[1] || id;
  const take = (it) => { if (it && (it.seller?.username || "").toLowerCase() !== own && !cands.has(legacy(it.itemId))) cands.set(legacy(it.itemId), it.itemId); };
  const gtin = String(barcode || "").replace(/\D/g, "");
  const searches = [];
  if (gtin.length >= 8 && gtin.length <= 14) searches.push(ebayGet(`/buy/browse/v1/item_summary/search?gtin=${gtin}&filter=${filter}&limit=20`).then((r) => ({ r, gtin: true })));
  if (want.length) searches.push(ebayGet(`/buy/browse/v1/item_summary/search?q=${encodeURIComponent(want.slice(0, 5).join(" "))}&filter=${filter}&limit=50`).then((r) => ({ r })));
  const res = await Promise.all(searches);
  if (res.some((x) => x.r.status === 429)) return { checked: false, rateLimited: true, reason: "eBay daily limit reached" };
  if (!res.length || res.every((x) => !x.r.ok)) return { checked: false, reason: "eBay search failed (" + (res[0]?.r.status ?? "no search terms") + ")" };
  for (const { r, gtin: g } of res) {
    if (!r.ok) continue;
    for (const it of r.body.itemSummaries || []) {
      if (g) { take(it); continue; }
      const t = new Set(tokens(it.title));
      if (key.length && key.filter((w) => t.has(w)).length / key.length >= minOverlap) take(it);
    }
  }
  const ids = [...cands.values()].slice(0, maxListings);
  const now = Date.now(); let limited = false;
  const rows = (await Promise.all(ids.map(async (id) => {
    const r = await ebayGet("/buy/browse/v1/item/" + encodeURIComponent(id));
    if (r.status === 429) { limited = true; return null; }
    if (!r.ok) return null;
    const sold = Number(r.body.estimatedAvailabilities?.[0]?.estimatedSoldQuantity) || 0;
    const created = Date.parse(r.body.itemCreationDate || "") || now - 30 * 864e5;
    const months = Math.max(1, (now - created) / (30.44 * 864e5));
    return { title: r.body.title, sold, perMonth: Math.round((sold / months) * 10) / 10, listedMonths: Math.round(months * 10) / 10, url: r.body.itemWebUrl };
  }))).filter(Boolean);
  if (limited && !rows.length) return { checked: false, rateLimited: true, reason: "eBay daily limit reached" };
  if (ids.length && !rows.length) return { checked: false, reason: "eBay didn't return listing details – try again later" };
  rows.sort((a, b) => b.perMonth - a.perMonth);
  return {
    checked: true, listings: rows.length, similarFound: cands.size,
    sold: rows.reduce((s, x) => s + x.sold, 0),
    perMonth: Math.round(rows.reduce((s, x) => s + x.perMonth, 0)),
    top: rows.slice(0, 3), searchUrl: ebaySearchUrl(name), at: new Date().toISOString(),
  };
}

/** Demand band used in reports. */
export const demandBand = (perMonth) => perMonth == null ? "not checked" : perMonth >= 1000 ? "1000+ a month" : perMonth >= 100 ? "100–999 a month" : perMonth >= 10 ? "10–99 a month" : perMonth >= 1 ? "1–9 a month" : "no sales";
