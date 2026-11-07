// POST /api/checkout {id, quantity} → creates a Stripe Checkout page for one eBay listing and returns its URL.
// The price is always re-read from eBay on the server, so it can't be changed by the browser.
import { getProduct, configProblem, json, env } from "../lib/shop.mjs";

const STRIPE_API = () => env("STRIPE_API_BASE", "https://api.stripe.com");

function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? prefix + "[" + k + "]" : k;
    if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const problem = configProblem() || (env("STRIPE_SECRET_KEY") ? null : "Missing settings: STRIPE_SECRET_KEY");
  if (problem) return json({ error: "Checkout isn't set up yet. Please message us on WhatsApp to order." , detail: problem }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const qty = Math.min(Math.max(parseInt(body.quantity, 10) || 1, 1), 10);

  let p;
  try {
    p = await getProduct(String(body.id || ""));
  } catch (e) {
    return json({ error: e.code ? e.message : "Couldn't check this item with eBay. Please try again." }, e.code || 502);
  }

  const origin = new URL(req.url).origin;
  const shipPence = Math.round((parseFloat(env("SHIPPING_FEE_GBP", "0")) || 0) * 100);
  const countries = env("SHIP_COUNTRIES", "GB").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);

  const params = form({
    mode: "payment",
    success_url: origin + "/thanks.html?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: origin + "/#item=" + encodeURIComponent(p.id),
    line_items: {
      0: {
        quantity: qty,
        adjustable_quantity: { enabled: true, minimum: 1, maximum: 10 },
        price_data: {
          currency: "gbp",
          unit_amount: p.pricePence,
          product_data: {
            name: p.title.slice(0, 250),
            images: p.images[0] ? { 0: p.images[0] } : undefined,
            metadata: { ebay_item_id: p.id },
          },
        },
      },
    },
    shipping_address_collection: { allowed_countries: Object.fromEntries(countries.map((c, i) => [i, c])) },
    shipping_options: {
      0: {
        shipping_rate_data: {
          type: "fixed_amount",
          display_name: env("SHIPPING_LABEL", shipPence ? "Royal Mail – UK delivery" : "Free UK delivery"),
          fixed_amount: { amount: shipPence, currency: "gbp" },
        },
      },
    },
    phone_number_collection: { enabled: true },
    metadata: { ebay_item_id: p.id, ebay_url: (p.ebayUrl || "").slice(0, 490) },
    payment_intent_data: { description: "Wufa: " + p.title.slice(0, 200) },
  });

  const res = await fetch(STRIPE_API() + "/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env("STRIPE_SECRET_KEY"), "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const s = await res.json().catch(() => ({}));
  if (!res.ok || !s.url) {
    console.error("Stripe error", res.status, JSON.stringify(s).slice(0, 500));
    return json({ error: "Payment page couldn't be opened. Please try again or message us on WhatsApp." }, 502);
  }
  return json({ url: s.url });
};

export const config = { path: "/api/checkout" };
