// POST /api/stripe-webhook – Stripe tells the site when a website payment completes.
// • Agent (dropship) products → creates an order and emails you the order pack (place it with the supplier, enter tracking).
// • Your own products → emails you the order details so you can post it from your stock.
// Every request is verified with your webhook signing secret (STRIPE_WEBHOOK_SECRET); anything unsigned is refused.
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { getJSON, setJSON, newId } from "../lib/agent/store.mjs";
import { sendEmail, orderPackEmail, ownOrderEmail } from "../lib/agent/email.mjs";

const STRIPE_API = () => env("STRIPE_API_BASE", "https://api.stripe.com");
const legacyOf = (id) => String(id || "").split("|")[1] || String(id || "");

/** Stripe signature check: header "t=…,v1=…"; HMAC-SHA256 of "t.payload"; 5-minute tolerance. */
export function verifyStripe(payload, header, secret, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map((x) => x.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(t + "." + payload).digest("hex");
  const sigs = String(header).split(",").filter((x) => x.trim().startsWith("v1=")).map((x) => x.trim().slice(3));
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

async function lineItems(sessionId) {
  try {
    const r = await fetch(STRIPE_API() + `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=10`, { headers: { Authorization: "Bearer " + env("STRIPE_SECRET_KEY") } });
    const j = await r.json();
    return r.ok ? j.data || [] : [];
  } catch { return []; }
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const payload = await req.text();
  if (!verifyStripe(payload, req.headers.get("stripe-signature"), env("STRIPE_WEBHOOK_SECRET"))) return new Response("Bad signature", { status: 400 });
  let ev; try { ev = JSON.parse(payload); } catch { return new Response("Bad JSON", { status: 400 }); }
  if (ev.type !== "checkout.session.completed" && ev.type !== "checkout.session.async_payment_succeeded") return new Response("ignored");
  const s = ev.data?.object || {};
  if (s.payment_status !== "paid") return new Response("not paid yet");
  if (await getJSON("stripe/" + s.id)) return new Response("already handled"); // Stripe may send the same event twice
  await setJSON("stripe/" + s.id, { at: new Date().toISOString(), event: ev.id });

  const ship = s.collected_information?.shipping_details || s.shipping_details || {};
  const addr = ship.address || s.customer_details?.address || {};
  const shipTo = { name: ship.name || s.customer_details?.name || "", line1: addr.line1 || "", line2: addr.line2 || "", city: addr.city || "", postcode: addr.postal_code || "", country: addr.country || "", phone: s.customer_details?.phone || "" };
  const items = await lineItems(s.id);
  const qty = items.reduce((n, li) => n + (li.quantity || 0), 0) || 1;
  const itemId = s.metadata?.ebay_item_id || "";
  const L = await getJSON("listing/" + legacyOf(itemId));
  const base = { channel: "website", channelOrderId: s.id.slice(-10), stripeSession: s.id, paymentIntent: s.payment_intent || "", buyerEmail: s.customer_details?.email || "",
    quantity: qty, option: s.metadata?.option || "", shipTo, paidPence: s.amount_total || 0, createdAt: new Date().toISOString() };

  if (L?.dropship) {
    const p = L.proposalId ? await getJSON("proposal/" + L.proposalId) : null;
    const q = L.queueKey ? await getJSON(L.queueKey) : null;
    const costPence = p?.pricing?.costPence ? p.pricing.costPence * qty : null;
    const dispatchDays = p?.dispatchDays ?? 2;
    const order = { ...base, id: newId("O"), status: "awaiting_payment", listingId: L.listingId,
      title: p?.title || L.title || "Product", supplierName: p?.supplier?.name || L.supplier, supplierUrl: p?.supplier?.url || "", supplierProductUrl: p?.supplierProductUrl || "",
      supplierSku: q?.sku || L.supplierSku || "", expectedCostPence: costPence, expectedProfitPence: costPence != null ? base.paidPence - costPence - Math.round(base.paidPence * 0.015 + 20) : null,
      surchargeArea: /^(BT|HS|IV|KW|ZE|PA[2-8]\d|PH(1[7-9]|[2-4]\d)|KA2[78]|IM|GY|JE)/i.test(String(shipTo.postcode).replace(/\s+/g, "")) ? "Northern Ireland, Highlands, Islands or Channel Islands – the supplier charges extra delivery here (e.g. Something Different £8.39); check the cost before paying" : "",
      dispatchBy: `Order today – the supplier dispatches within ${dispatchDays} working day${dispatchDays === 1 ? "" : "s"}`, history: [{ at: base.createdAt, note: "Website payment received (Stripe)" }] };
    await setJSON("order/" + order.id, order);
    await sendEmail(orderPackEmail(order));
    return new Response("order created");
  }
  await sendEmail(ownOrderEmail({ ...base, title: s.metadata?.title || items[0]?.description || "Website order", ebayUrl: s.metadata?.ebay_url || "" }));
  return new Response("notified");
};

export const config = { path: "/api/stripe-webhook" };
