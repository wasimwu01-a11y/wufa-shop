// Shared helpers for the Wufa shop functions.
// Reads the seller's live eBay listings (Browse API, app token only – no access to the eBay account itself)
// and prices them for the website.
//
// Environment variables (set in Netlify → Project configuration → Environment variables):
//   EBAY_CLIENT_ID       eBay developer "App ID (Client ID)" – Production keyset
//   EBAY_CLIENT_SECRET   eBay developer "Cert ID (Client Secret)" – Production keyset
//   EBAY_SELLER          (optional) eBay username – defaults to nuvr_61
//   STRIPE_SECRET_KEY    Stripe secret or restricted key (sk_live_... / rk_live_...)
// Optional:
//   SITE_DISCOUNT_PERCENT   e.g. 10 → website price is 10% below the eBay price (default 0)
//   SHIPPING_FEE_GBP        delivery charge per order at checkout, e.g. 2.50 (default 0 = free delivery)
//   SHIPPING_LABEL          text shown at checkout for delivery (default "Royal Mail – UK delivery")
//   SHIP_COUNTRIES          comma-separated country codes you post to (default GB)
//   EBAY_MARKETPLACE        default EBAY_GB

const env = (k, d = "") => (process.env[k] ?? d).toString().trim();

const EBAY_API = () => env("EBAY_API_BASE", "https://api.ebay.com"); // overridable for testing
const MARKETPLACE = () => env("EBAY_MARKETPLACE", "EBAY_GB");

let tokenCache = { token: null, expires: 0 };

export function configProblem() {
  const missing = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"].filter((k) => !env(k));
  return missing.length ? "Missing settings: " + missing.join(", ") : null;
}

async function ebayToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  const basic = Buffer.from(env("EBAY_CLIENT_ID") + ":" + env("EBAY_CLIENT_SECRET")).toString("base64");
  const res = await fetch(EBAY_API() + "/identity/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error("eBay sign-in failed (" + res.status + "): " + (await res.text()).slice(0, 300));
  const j = await res.json();
  tokenCache = { token: j.access_token, expires: Date.now() + (Number(j.expires_in || 7200) - 120) * 1000 };
  return tokenCache.token;
}

async function ebayGet(path) {
  const res = await fetch(EBAY_API() + path, {
    headers: {
      Authorization: "Bearer " + (await ebayToken()),
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE(),
      "Accept-Language": "en-GB",
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

export function sitePrice(ebayValue) {
  const pct = Math.min(Math.max(parseFloat(env("SITE_DISCOUNT_PERCENT", "0")) || 0, 0), 90);
  const pence = Math.round(parseFloat(ebayValue) * 100 * (1 - pct / 100));
  return pence; // integer pence
}

function bigImage(url) {
  // eBay thumbnails come as s-l225 etc.; ask for the 1600px version.
  return url ? url.replace(/s-l\d+\.(jpg|jpeg|png|webp)/i, "s-l1600.$1") : url;
}

function shape(it) {
  const imgs = [it.image?.imageUrl, ...(it.additionalImages || []).map((x) => x.imageUrl)]
    .filter(Boolean)
    .map(bigImage);
  return {
    id: it.itemId,
    title: it.title,
    pricePence: sitePrice(it.price?.value),
    ebayPrice: it.price?.value,
    currency: it.price?.currency,
    condition: it.condition || "",
    images: [...new Set(imgs)],
    ebayUrl: it.itemWebUrl,
    description: it.shortDescription || "",
  };
}

async function searchPages(baseQuery, cap) {
  const items = [];
  for (let offset = 0; offset < cap; offset += 200) {
    const r = await ebayGet(baseQuery + "&limit=200&offset=" + offset);
    if (!r.ok) return { error: r, items };
    const page = r.body.itemSummaries || [];
    items.push(...page);
    if (!r.body.next || page.length === 0) break;
  }
  return { items };
}

// Returns the seller's live fixed-price listings in GBP.
export async function listProducts() {
  const seller = env("EBAY_SELLER", "nuvr_61");
  const filter = encodeURIComponent("sellers:{" + seller + "},buyingOptions:{FIXED_PRICE}");
  const base = "/buy/browse/v1/item_summary/search?filter=" + filter;

  // 1) Fast path: one search across all categories.
  let { items, error } = await searchPages(base + "&category_ids=0", 1000);

  // 2) Fallback: if eBay rejects that, search each top-level category and merge.
  if (error || items.length === 0) {
    const tree = await ebayGet("/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=" + MARKETPLACE());
    const treeId = tree.ok ? tree.body.categoryTreeId : "3";
    const t = await ebayGet("/commerce/taxonomy/v1/category_tree/" + treeId);
    if (!t.ok) throw new Error("eBay category lookup failed (" + t.status + ")");
    const cats = (t.body.rootCategoryNode?.childCategoryTreeNodes || []).map((n) => n.category.categoryId);
    items = [];
    const results = await Promise.all(cats.map((c) => searchPages(base + "&category_ids=" + c, 400)));
    for (const r of results) items.push(...r.items);
    if (items.length === 0 && error) throw new Error("eBay search failed (" + error.status + "): " + JSON.stringify(error.body).slice(0, 300));
  }

  const seen = new Set();
  return items
    .filter((it) => it.seller?.username?.toLowerCase() === seller.toLowerCase() || !it.seller)
    .filter((it) => (seen.has(it.itemId) ? false : seen.add(it.itemId)))
    .map(shape)
    .filter((p) => p.currency === "GBP" && p.pricePence > 0);
}

// Fetches one listing live and checks it really is ours and still for sale.
export async function getProduct(itemId) {
  if (!/^v1\|\d+\|\d+$/.test(itemId)) throw Object.assign(new Error("Invalid item"), { code: 400 });
  const r = await ebayGet("/buy/browse/v1/item/" + encodeURIComponent(itemId));
  if (r.status === 404) throw Object.assign(new Error("This item is no longer available"), { code: 404 });
  if (!r.ok) throw new Error("eBay item lookup failed (" + r.status + ")");
  const it = r.body;
  if ((it.seller?.username || "").toLowerCase() !== env("EBAY_SELLER", "nuvr_61").toLowerCase())
    throw Object.assign(new Error("Item not sold by this shop"), { code: 403 });
  if (!(it.buyingOptions || []).includes("FIXED_PRICE"))
    throw Object.assign(new Error("Item is not a fixed-price listing"), { code: 409 });
  const avail = it.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus;
  if (avail === "OUT_OF_STOCK") throw Object.assign(new Error("This item is out of stock"), { code: 409 });
  if (it.itemEndDate && Date.parse(it.itemEndDate) < Date.now())
    throw Object.assign(new Error("This listing has ended"), { code: 409 });
  if (it.price?.currency !== "GBP") throw Object.assign(new Error("Item not priced in GBP"), { code: 409 });
  return shape(it);
}

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

export { env };
