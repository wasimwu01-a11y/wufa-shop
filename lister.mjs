// Creates the eBay listing for an approved product (Sell Inventory API):
// supplier location → inventory item (title, description, photos, item specifics) → offer (price, category,
// policies) → publish. Only products from the supplier files (known cost) are listed automatically.
import { env } from "./config.mjs";
import { getJSON, setJSON, listKeys, update } from "./store.mjs";
import { sell, ebayImage, ebayErrors } from "./ebayuser.mjs";
import { ebayGet } from "../shop.mjs";
import { SUPPLIERS } from "./catalog.mjs";
import { buildDescription } from "./describe.mjs";

const TREE = "3"; // eBay UK category tree

export const LOCATIONS = {
  sd: { key: "wufa-sd-swansea", name: "Something Different warehouse", city: "Swansea", stateOrProvince: "Swansea", postalCode: env("SD_POSTCODE") },
  aw: { key: "wufa-aw-sheffield", name: "AW warehouse", city: "Sheffield", stateOrProvince: "South Yorkshire", postalCode: env("AW_POSTCODE") },
  cj: { key: "wufa-cj-uk", name: "CJ UK warehouse", city: env("CJ_LOCATION_CITY", "UK warehouse"), stateOrProvince: env("CJ_LOCATION_REGION", "England"), postalCode: env("CJ_POSTCODE") },
};
// Postage policies you create once in Seller Hub (free UK postage, the right handling time). Names can be changed in Netlify.
const POSTAGE = { sd: () => env("EBAY_POSTAGE_POLICY_SD", "Wufa DS 1 day"), aw: () => env("EBAY_POSTAGE_POLICY_AW", "Wufa DS 2 days"), cj: () => env("EBAY_POSTAGE_POLICY_CJ", "Wufa DS 2 days") };

export const ebaySku = (supplier, sku) => ("DS-" + supplier.toUpperCase() + "-" + sku).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 50);
const fail = (msg, fix) => Object.assign(new Error(msg), { fix });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** sell() with retries on eBay's temporary errors (5xx, rate limit, network). Only for repeatable calls. */
async function sellR(method, path, body, tries = 3) {
  let r;
  for (let i = 0; i < tries; i++) {
    try { r = await sell(method, path, body); } catch (e) {
      if (e.code === "NOT_CONNECTED") throw e;
      r = { ok: false, status: 0, body: { errors: [{ message: "Couldn't reach eBay: " + (e.message || e) }] } };
    }
    if (r.ok || (r.status && r.status < 500 && r.status !== 429)) return r;
    await pause(2000 * (i + 1));
  }
  return r;
}

async function ensureLocation(sup) {
  const L = LOCATIONS[sup];
  const g = await sellR("GET", "/sell/inventory/v1/location/" + L.key);
  if (g.ok) return L.key;
  const address = { city: L.city, stateOrProvince: L.stateOrProvince, country: "GB", ...(L.postalCode ? { postalCode: L.postalCode } : {}) };
  const c = await sellR("POST", "/sell/inventory/v1/location/" + L.key, { location: { address }, locationTypes: ["WAREHOUSE"], name: L.name, merchantLocationStatus: "ENABLED" });
  if (!c.ok && c.status !== 409) throw fail("Couldn't set the item location: " + ebayErrors(c));
  return L.key;
}

async function policies(sup) {
  const [f, r, p] = await Promise.all([
    sellR("GET", "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_GB"),
    sellR("GET", "/sell/account/v1/return_policy?marketplace_id=EBAY_GB"),
    sellR("GET", "/sell/account/v1/payment_policy?marketplace_id=EBAY_GB"),
  ]);
  if ([f, r, p].some((x) => x.status === 400 || x.status === 403) && /business polic|opted/i.test(ebayErrors(f) + ebayErrors(r) + ebayErrors(p)))
    throw fail("Your eBay account isn't using business policies yet.", "In Seller Hub go to Account → Business policies and opt in, then create the postage policies below.");
  const byName = (list, name) => (list || []).find((x) => x.name?.trim().toLowerCase() === name.toLowerCase());
  const want = POSTAGE[sup]();
  const bad = [f, r, p].find((x) => !x.ok);
  if (bad) throw fail("eBay didn't return your business policies: " + ebayErrors(bad), "Usually temporary – press Try again in a few minutes.");
  const ful = byName(f.body?.fulfillmentPolicies, want);
  if (!ful) throw fail(`Postage policy "${want}" not found on eBay.`,
    `In Seller Hub → Account → Business policies → Create policy → Postage: name it exactly "${want}", Royal Mail Tracked 48 (or similar tracked service), FREE postage, handling time ${SUPPLIERS[sup].dispatchDays} working day(s), and exclude Northern Ireland, Highlands & Islands (or add a surcharge) because the supplier charges more there.`);
  const ret = byName(r.body?.returnPolicies, env("EBAY_RETURN_POLICY", "")) || (r.body?.returnPolicies || [])[0];
  const pay = byName(p.body?.paymentPolicies, env("EBAY_PAYMENT_POLICY", "")) || (p.body?.paymentPolicies || [])[0];
  if (!ret) throw fail("No returns policy found on eBay.", "Create a Returns policy in Seller Hub → Business policies (30-day returns is normal).");
  if (!pay) throw fail("No payment policy found on eBay.", "Create a Payment policy in Seller Hub → Business policies.");
  return { fulfillmentPolicyId: ful.fulfillmentPolicyId, returnPolicyId: ret.returnPolicyId, paymentPolicyId: pay.paymentPolicyId };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** GET on eBay's public APIs with one retry on temporary errors. */
async function getRetry(path) {
  let r;
  for (let i = 0; i < 3; i++) {
    try { r = await ebayGet(path); } catch (e) { r = { ok: false, status: 0, body: { errors: [{ message: String(e.message || e) }] } }; }
    if (r.ok || (r.status && r.status < 500 && r.status !== 429)) return r;
    await sleep(1500 * (i + 1));
  }
  return r;
}

/** Category ideas from several angles: your hint, the title, a cleaned title, the supplier's own category. */
async function categories(title, q, hint) {
  const clean = (t) => String(t || "").replace(/[–—&+,.()/|:;!"']/g, " ").replace(/\b(one|standard|free)\s+size\b/gi, " ").replace(/\s+/g, " ").trim();
  const supCat = String(q.category || "").split(">").pop().trim();
  const queries = [...new Set([hint, title, clean(title), clean(title).split(" ").slice(0, 4).join(" "), supCat && clean(title).split(" ").slice(0, 3).join(" ") + " " + supCat, supCat]
    .map((x) => String(x || "").trim()).filter((x) => x.length >= 3))];
  const out = []; const seen = new Set(); let apiError = null;
  if (/^\d{3,7}$/.test(String(hint || "").trim())) { out.push({ id: String(hint).trim(), name: "category " + String(hint).trim() }); seen.add(String(hint).trim()); }
  for (const [qi, query] of queries.entries()) {
    const r = await getRetry(`/commerce/taxonomy/v1/category_tree/${TREE}/get_category_suggestions?q=` + encodeURIComponent(query.slice(0, 100)));
    if (!r.ok) { apiError = ebayErrors(r); continue; }
    for (const x of r.body?.categorySuggestions || []) {
      const c = x.category; if (!c || seen.has(c.categoryId)) continue;
      seen.add(c.categoryId); out.push({ id: c.categoryId, name: c.categoryName, fromHint: !!hint && qi === 0 });
    }
    if (out.length >= 10) break;
  }
  if (!out.length) throw fail(apiError ? "eBay's category service didn't answer: " + apiError : "eBay couldn't suggest a category for this item.",
    apiError ? "This is temporary on eBay's side – press Try again in a few minutes." : "Press Try again and type a plain description in the eBay category box (e.g. \"sarong\", \"cushion cover\").");
  // Prefer: categories from your hint, then ones whose name matches words in the title, then the rest (eBay's order kept).
  const tw = new Set(words(title + " " + (hint || "")).split(/[^a-z]+/).filter((w) => w.length > 2).map(singular));
  const match = (c) => String(c.name).toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2).some((w) => tw.has(singular(w)));
  const rank = (c) => (c.fromHint ? 0 : match(c) ? 1 : 2);
  return out.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c).slice(0, 10);
}

/** Picks the first suggested category whose required item specifics we can fill. */
async function pickCategory(title, q, hint) {
  const tried = [];
  for (const c of await categories(title, q, hint)) {
    const spec = await itemSpecifics(c.id, c.name, q, title, hint);
    if (!spec.missing.length) return { cat: c, spec };
    tried.push(`"${c.name}" needs ${spec.missing.join(", ")}`);
  }
  throw fail("eBay requires item details the agent couldn't work out. Categories tried: " + tried.join("; ") + ".",
    "Press Try again and add the missing details to the title (for example the size), or type a different item description in the eBay category box. Or drop this product.");
}

const words = (s) => String(s).toLowerCase();
const reEsc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SIZE_TOKEN = /\b(xxs|xs|xl|xxl|xxxl|[2-6]xl|size\s?(s|m|l)|small|medium|large|uk\s?\d{1,2}|eu\s?\d{2})\b/i;
const DIMENSIONS = /\b\d{1,4}(\.\d+)?\s?(x|×)\s?\d{1,4}(\.\d+)?(\s?(x|×)\s?\d{1,4}(\.\d+)?)?\s?(cm|mm|m|in|inch|")/i;
const singular = (w) => w.replace(/ies$/i, "y").replace(/(s|es)$/i, "");

/** Fills the category's required item specifics from what we know. Returns { aspects, missing }. */
async function itemSpecifics(catId, catName, it, title, hint) {
  const r = await getRetry(`/commerce/taxonomy/v1/category_tree/${TREE}/get_item_aspects_for_category?category_id=` + catId);
  if (!r.ok) return { aspects: {}, missing: ["(eBay didn't return its item details list: " + ebayErrors(r) + ")"] };
  const defs = r.body?.aspects || [];
  const text = words([title, it.name, it.material, it.description?.slice(0, 600), hint].filter(Boolean).join(" "));
  const leaf = String(catName || "").split(/[&,]/)[0].trim();
  const aspects = { Brand: ["Unbranded"], MPN: ["Does Not Apply"] };
  const missing = [];
  for (const d of defs) {
    const name = d.localizedAspectName;
    if (!name || aspects[name]) continue;
    const required = d.aspectConstraint?.aspectRequired;
    const values = (d.aspectValues || []).map((v) => v.localizedValue).filter(Boolean);
    const freeText = d.aspectConstraint?.aspectMode !== "SELECTION_ONLY";
    const has = (v) => values.find((x) => x.toLowerCase() === v.toLowerCase());
    // A listed value that appears in the text (longest first, so "Dark Green" beats "Green").
    let val = values.slice().sort((a, b) => b.length - a.length).find((v) => v.length > 2 && new RegExp("\\b" + reEsc(v.toLowerCase()) + "s?\\b").test(text));
    if (!val && !required) continue;
    if (!val && /^colou?r$/i.test(name)) val = has("Multicoloured") || has("Multicolour") || (freeText ? "Multicoloured" : null);
    if (!val && /^material$/i.test(name) && it.material) val = freeText ? it.material.slice(0, 65) : null;
    if (!val && /size|dimension/i.test(name) && freeText && DIMENSIONS.test(title)) val = title.match(DIMENSIONS)[0].replace(/\s+/g, " ");
    if (!val && /size/i.test(name) && !/^(shoe|ring|bra|cup)/i.test(name) && (/\b(one|standard|free|universal)[ -]size\b/.test(text) || !SIZE_TOKEN.test(title)))
      val = values.find((v) => /^one size/i.test(v)) || (freeText ? "One Size" : null);
    if (!val && /^(type|style|product type|product|sub-type|item type)$/i.test(name)) {
      const cands = [hint, leaf, singular(leaf)].filter(Boolean).map((x) => String(x).trim());
      val = cands.map(has).find(Boolean) || (freeText ? (hint ? hint.replace(/\b\w/g, (c) => c.toUpperCase()) : singular(leaf)).slice(0, 65) : null);
    }
    if (!val && /^department$/i.test(name)) {
      val = /\b(women|womens|women's|ladies|lady)\b/.test(text) ? has("Women") : /\b(men|mens|men's|gents)\b/.test(text) ? has("Men") : null;
      val = val || has("Unisex Adults") || has("Unisex Adult") || has("Unisex");
    }
    if (!val && /^(ean|upc|isbn|gtin|mpn|model|manufacturer part number)$/i.test(name)) val = "Does Not Apply";
    if (!val && /^(country|country\/region) of manufacture$/i.test(name)) val = has("Unknown") || null;
    if (val) aspects[name] = [val];
    else missing.push(name);
  }
  return { aspects, missing };
}

function description(p, q) {
  return buildDescription({ title: String(p.listingTitle || p.title).slice(0, 80), q, supplier: SUPPLIERS[q.supplier] });
}

/** All supplier photos (max 12), copied into eBay's picture service; any that can't be copied keep the supplier link. */
async function photos(q) {
  const list = [...new Set([...(q.images || []), q.image].filter((x) => /^https:\/\//.test(x || "")))].slice(0, 12);
  const out = [];
  for (let i = 0; i < list.length; i += 4) out.push(...(await Promise.all(list.slice(i, i + 4).map(ebayImage))));
  return out;
}

/** Lists one approved proposal. Returns { listingId, url }. Throws with .fix on problems you can solve. */
export async function listProposal(p) {
  if (p.source !== "catalog") throw fail("Only products from supplier files are listed automatically.", "List this one manually in Seller Hub, or add the supplier's product file to the screener.");
  const q = await getJSON(p.queueKey);
  if (!q) throw fail("The product's supplier details are missing.", "Re-add it with the screener.");
  if (!q.image) throw fail("The supplier file has no photo for this product.", "List it manually with your own photos.");
  const title = String(p.listingTitle || p.title).slice(0, 80);
  const sku = ebaySku(q.supplier, q.sku);
  const [loc, pol, { cat, spec }] = await Promise.all([ensureLocation(q.supplier), policies(q.supplier), pickCategory(title, q, p.categoryHint)]);
  const qty = Math.max(1, Math.min(5, Math.floor((q.stock || 0) - 2)));
  const pics = await photos(q);
  const pic = { error: pics.every((x) => x.error) ? pics[0]?.error : null };
  const desc = description(p, q);
  const item = (withWeight) => ({
    availability: { shipToLocationAvailability: { quantity: qty } },
    condition: "NEW",
    product: { title, description: desc.text.slice(0, 4000), aspects: spec.aspects, imageUrls: pics.map((x) => x.url) },
    ...(withWeight && q.weightKg > 0 ? { packageWeightAndSize: { weight: { value: Math.round(q.weightKg * 1000), unit: "GRAM" } } } : {}),
  });
  const put = (b) => sellR("PUT", "/sell/inventory/v1/inventory_item/" + encodeURIComponent(sku), b);
  let inv = await put(item(true));
  if (!inv.ok && (inv.status >= 500 || inv.status === 0)) inv = await put(item(false));
  if (!inv.ok) throw fail("eBay rejected the item details: " + ebayErrors(inv) + (pic.error ? ". eBay also couldn't copy the supplier's photo: " + pic.error : ""),
    pic.error ? "The supplier's photo link may not work for eBay. Press Try again later, or drop this product." : "This is usually temporary on eBay's side – press Try again in a few minutes.");
  const offer = {
    sku, marketplaceId: "EBAY_GB", format: "FIXED_PRICE", listingDuration: "GTC", availableQuantity: qty,
    categoryId: cat.id, listingDescription: desc.html.slice(0, 500000), merchantLocationKey: loc,
    listingPolicies: pol, pricingSummary: { price: { value: (p.pricing.pricePence / 100).toFixed(2), currency: "GBP" } },
  };
  const findOffer = async () => {
    const e = await sellR("GET", "/sell/inventory/v1/offer?sku=" + encodeURIComponent(sku) + "&marketplace_id=EBAY_GB");
    return e.ok ? (e.body?.offers || []).find((o) => o.marketplaceId === "EBAY_GB" || !o.marketplaceId)?.offerId || null : null;
  };
  let offerId = await findOffer();
  if (offerId) {
    const u = await sellR("PUT", "/sell/inventory/v1/offer/" + offerId, offer);
    if (!u.ok) throw fail("eBay rejected the price/category/policies: " + ebayErrors(u), "Press Try again; if it repeats, send this message to whoever set the agent up.");
  } else {
    const c = await sell("POST", "/sell/inventory/v1/offer", offer).catch((e) => ({ ok: false, status: 0, body: { errors: [{ message: String(e.message || e) }] } }));
    offerId = c.ok ? c.body?.offerId : null;
    if (!offerId) { await pause(2000); offerId = await findOffer(); } // a timed-out create may still have worked
    if (!offerId) throw fail("eBay rejected the price/category/policies: " + ebayErrors(c), "Press Try again; if it repeats, send this message to whoever set the agent up.");
  }
  const pub = await sellR("POST", `/sell/inventory/v1/offer/${offerId}/publish`);
  if (!pub.ok || !pub.body?.listingId) throw fail("eBay refused to publish: " + ebayErrors(pub), "The message above is eBay's own reason. Fix it in Seller Hub if it's about your account or policies, or edit the title, then press Try again.");
  const listingId = String(pub.body.listingId);
  await setJSON("listing/" + listingId, { listingId, sku, offerId, supplier: q.supplier, supplierSku: q.sku, proposalId: p.id, queueKey: p.queueKey,
    pricePence: p.pricing.pricePence, quantity: qty, categoryId: cat.id, dropship: true, listedAt: new Date().toISOString() });
  await update(p.queueKey, { status: "listed", listingId }, "Listed on eBay");
  return { listingId, url: "https://www.ebay.co.uk/itm/" + listingId, categoryName: cat.name, quantity: qty, sku, photos: pics.length };
}

/** Listing IDs created by the agent (used to keep dropship items off the website until website orders are automated). */
export async function agentListingIds() {
  return new Set((await listKeys("listing/")).map((k) => k.slice("listing/".length)));
}
