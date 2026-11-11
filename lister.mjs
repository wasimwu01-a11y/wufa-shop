// Creates the eBay listing for an approved product (Sell Inventory API):
// supplier location → inventory item (title, description, photos, item specifics) → offer (price, category,
// policies) → publish. Only products from the supplier files (known cost) are listed automatically.
import { env } from "./config.mjs";
import { getJSON, setJSON, listKeys, update } from "./store.mjs";
import { sell, ebayImage, ebayErrors } from "./ebayuser.mjs";
import { ebayGet } from "../shop.mjs";
import { SUPPLIERS } from "./catalog.mjs";
import { esc } from "./email.mjs";

const TREE = "3"; // eBay UK category tree

export const LOCATIONS = {
  sd: { key: "wufa-sd-swansea", name: "Something Different warehouse", city: "Swansea", stateOrProvince: "Swansea", postalCode: env("SD_POSTCODE") },
  aw: { key: "wufa-aw-sheffield", name: "AW warehouse", city: "Sheffield", stateOrProvince: "South Yorkshire", postalCode: env("AW_POSTCODE") },
};
// Postage policies you create once in Seller Hub (free UK postage, the right handling time). Names can be changed in Netlify.
const POSTAGE = { sd: () => env("EBAY_POSTAGE_POLICY_SD", "Wufa DS 1 day"), aw: () => env("EBAY_POSTAGE_POLICY_AW", "Wufa DS 2 days") };

export const ebaySku = (supplier, sku) => ("DS-" + supplier.toUpperCase() + "-" + sku).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 50);
const fail = (msg, fix) => Object.assign(new Error(msg), { fix });

async function ensureLocation(sup) {
  const L = LOCATIONS[sup];
  const g = await sell("GET", "/sell/inventory/v1/location/" + L.key);
  if (g.ok) return L.key;
  const address = { city: L.city, stateOrProvince: L.stateOrProvince, country: "GB", ...(L.postalCode ? { postalCode: L.postalCode } : {}) };
  const c = await sell("POST", "/sell/inventory/v1/location/" + L.key, { location: { address }, locationTypes: ["WAREHOUSE"], name: L.name, merchantLocationStatus: "ENABLED" });
  if (!c.ok && c.status !== 409) throw fail("Couldn't set the item location: " + ebayErrors(c));
  return L.key;
}

async function policies(sup) {
  const [f, r, p] = await Promise.all([
    sell("GET", "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_GB"),
    sell("GET", "/sell/account/v1/return_policy?marketplace_id=EBAY_GB"),
    sell("GET", "/sell/account/v1/payment_policy?marketplace_id=EBAY_GB"),
  ]);
  if ([f, r, p].some((x) => x.status === 400 || x.status === 403) && /business polic|opted/i.test(ebayErrors(f) + ebayErrors(r)))
    throw fail("Your eBay account isn't using business policies yet.", "In Seller Hub go to Account → Business policies and opt in, then create the postage policies below.");
  const byName = (list, name) => (list || []).find((x) => x.name?.trim().toLowerCase() === name.toLowerCase());
  const want = POSTAGE[sup]();
  const ful = byName(f.body?.fulfillmentPolicies, want);
  if (!ful) throw fail(`Postage policy "${want}" not found on eBay.`,
    `In Seller Hub → Account → Business policies → Create policy → Postage: name it exactly "${want}", Royal Mail Tracked 48 (or similar tracked service), FREE postage, handling time ${SUPPLIERS[sup].dispatchDays} working day(s), and exclude Northern Ireland, Highlands & Islands (or add a surcharge) because the supplier charges more there.`);
  const ret = byName(r.body?.returnPolicies, env("EBAY_RETURN_POLICY", "")) || (r.body?.returnPolicies || [])[0];
  const pay = byName(p.body?.paymentPolicies, env("EBAY_PAYMENT_POLICY", "")) || (p.body?.paymentPolicies || [])[0];
  if (!ret) throw fail("No returns policy found on eBay.", "Create a Returns policy in Seller Hub → Business policies (30-day returns is normal).");
  if (!pay) throw fail("No payment policy found on eBay.", "Create a Payment policy in Seller Hub → Business policies.");
  return { fulfillmentPolicyId: ful.fulfillmentPolicyId, returnPolicyId: ret.returnPolicyId, paymentPolicyId: pay.paymentPolicyId };
}

async function categories(query) {
  const r = await ebayGet(`/commerce/taxonomy/v1/category_tree/${TREE}/get_category_suggestions?q=` + encodeURIComponent(query.slice(0, 100)));
  const list = (r.ok ? r.body.categorySuggestions || [] : []).map((x) => x.category).filter(Boolean).slice(0, 5);
  if (!list.length) throw fail("eBay couldn't suggest a category for this title.", "Edit the title to describe the item plainly and press Try again.");
  return list.map((c) => ({ id: c.categoryId, name: c.categoryName }));
}

/** Picks the first suggested category whose required item specifics we can fill. */
async function pickCategory(title, q, hint) {
  const tried = [];
  for (const c of await categories(hint || title)) {
    const spec = await itemSpecifics(c.id, c.name, q, title + " " + (hint || ""));
    if (!spec.missing.length) return { cat: c, spec };
    tried.push(`"${c.name}" needs ${spec.missing.join(", ")}`);
  }
  throw fail("eBay requires item specifics the agent couldn't work out: " + tried.join("; ") + ".",
    "Press Try again and fill in the eBay category box (e.g. \"sarong\"), and/or add the missing details to the title (e.g. \"One Size\"). Or list this one manually.");
}

const words = (s) => String(s).toLowerCase();
/** Fills the category's required item specifics from what we know. Returns { aspects, missing }. */
async function itemSpecifics(catId, catName, it, title) {
  const r = await ebayGet(`/commerce/taxonomy/v1/category_tree/${TREE}/get_item_aspects_for_category?category_id=` + catId);
  const defs = r.ok ? r.body.aspects || [] : [];
  const text = words(title + " " + (it.name || "") + " " + (it.material || ""));
  const aspects = { Brand: ["Unbranded"], MPN: ["Does Not Apply"] };
  const missing = [];
  for (const d of defs) {
    const name = d.localizedAspectName;
    if (!name || aspects[name]) continue;
    const required = d.aspectConstraint?.aspectRequired;
    const values = (d.aspectValues || []).map((v) => v.localizedValue);
    const freeText = d.aspectConstraint?.aspectMode === "FREE_TEXT";
    // A listed value that appears in the title (longest first, so "Dark Green" beats "Green").
    const hit = values.slice().sort((a, b) => b.length - a.length).find((v) => v.length > 2 && new RegExp("\\b" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase() + "\\b").test(text));
    let val = hit;
    if (!val && /^(colou?r)$/i.test(name) && values.includes("Multicoloured")) val = required ? "Multicoloured" : null;
    if (!val && /^material$/i.test(name) && it.material && freeText) val = it.material.slice(0, 65);
    if (!val && /^type$/i.test(name) && freeText) val = catName;
    if (!val && /^size$/i.test(name) && /\b(one|standard|free|universal)[ -]size\b|\bone size fits\b/.test(text)) {
      const one = values.find((v) => /^one size/i.test(v));
      val = one || (freeText || !values.length ? "One Size" : null);
    }
    if (!val && /^(department)$/i.test(name) && values.includes("Unisex Adults")) val = "Unisex Adults";
    if (val) aspects[name] = [val];
    else if (required) missing.push(name);
  }
  return { aspects, missing };
}

function description(p, q) {
  const s = SUPPLIERS[q.supplier];
  const paras = String(q.description || p.title).split(/\n+|(?<=\.)\s{2,}/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
  return `<h2>${esc(p.listingTitle || p.title)}</h2>${paras.map((x) => "<p>" + esc(x) + "</p>").join("")}
<ul><li>Brand new</li><li>Dispatched within ${s.dispatchDays} working day${s.dispatchDays > 1 ? "s" : ""} from our UK warehouse partner</li><li>Tracked UK delivery</li></ul>`;
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
  const pic = await ebayImage(q.image);
  const item = (withWeight) => ({
    availability: { shipToLocationAvailability: { quantity: qty } },
    condition: "NEW",
    product: { title, description: description(p, q).slice(0, 4000), aspects: spec.aspects, imageUrls: [pic.url] },
    ...(withWeight && q.weightKg > 0 ? { packageWeightAndSize: { weight: { value: Math.round(q.weightKg * 1000), unit: "GRAM" } } } : {}),
  });
  const put = (b) => sell("PUT", "/sell/inventory/v1/inventory_item/" + encodeURIComponent(sku), b);
  let inv = await put(item(true));
  if (!inv.ok && inv.status >= 500) { await new Promise((r) => setTimeout(r, 3000)); inv = await put(item(true)); }
  if (!inv.ok && inv.status >= 500) inv = await put(item(false));
  if (!inv.ok) throw fail("eBay rejected the item details: " + ebayErrors(inv) + (pic.error ? ". eBay also couldn't copy the supplier's photo: " + pic.error : ""),
    pic.error ? "The supplier's photo link may not work for eBay. Press Try again later, or drop this product." : "This is usually temporary on eBay's side – press Try again in a few minutes.");
  const offer = {
    sku, marketplaceId: "EBAY_GB", format: "FIXED_PRICE", listingDuration: "GTC", availableQuantity: qty,
    categoryId: cat.id, listingDescription: description(p, q).slice(0, 500000), merchantLocationKey: loc,
    listingPolicies: pol, pricingSummary: { price: { value: (p.pricing.pricePence / 100).toFixed(2), currency: "GBP" } },
  };
  const existing = await sell("GET", "/sell/inventory/v1/offer?sku=" + encodeURIComponent(sku) + "&marketplace_id=EBAY_GB");
  let offerId = existing.ok ? existing.body?.offers?.[0]?.offerId : null;
  if (offerId) {
    const u = await sell("PUT", "/sell/inventory/v1/offer/" + offerId, offer);
    if (!u.ok) throw fail("eBay rejected the offer update: " + ebayErrors(u));
  } else {
    const c = await sell("POST", "/sell/inventory/v1/offer", offer);
    if (!c.ok || !c.body?.offerId) throw fail("eBay rejected the offer: " + ebayErrors(c));
    offerId = c.body.offerId;
  }
  const pub = await sell("POST", `/sell/inventory/v1/offer/${offerId}/publish`);
  if (!pub.ok || !pub.body?.listingId) throw fail("eBay refused to publish: " + ebayErrors(pub), "Check the message above; fix it in Seller Hub or edit the title, then press Try again.");
  const listingId = String(pub.body.listingId);
  await setJSON("listing/" + listingId, { listingId, sku, offerId, supplier: q.supplier, supplierSku: q.sku, proposalId: p.id, queueKey: p.queueKey,
    pricePence: p.pricing.pricePence, quantity: qty, categoryId: cat.id, dropship: true, listedAt: new Date().toISOString() });
  await update(p.queueKey, { status: "listed", listingId }, "Listed on eBay");
  return { listingId, url: "https://www.ebay.co.uk/itm/" + listingId, categoryName: cat.name, quantity: qty, sku };
}

/** Listing IDs created by the agent (used to keep dropship items off the website until website orders are automated). */
export async function agentListingIds() {
  return new Set((await listKeys("listing/")).map((k) => k.slice("listing/".length)));
}
