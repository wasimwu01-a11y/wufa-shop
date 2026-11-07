// Emails from the agent, sent through Resend. Always to AGENT_EMAIL only.
// Every value that came from the web (product names, supplier text) is escaped before it goes into the email.
import { AGENT_EMAIL, APPROVAL_TTL_DAYS, ORDER_TTL_DAYS, env, siteUrl } from "./config.mjs";
import { makeToken } from "./tokens.mjs";
import { gbp } from "./pricing.mjs";

const RESEND = () => env("RESEND_API_BASE", "https://api.resend.com");

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Only http(s) links are allowed into emails.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");

export async function sendEmail({ subject, html, text }) {
  const key = env("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const res = await fetch(RESEND() + "/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env("AGENT_FROM", "Wufa Agent <onboarding@resend.dev>"),
      to: [AGENT_EMAIL],
      subject: subject.slice(0, 200),
      html,
      text,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Email failed (" + res.status + "): " + JSON.stringify(j).slice(0, 300));
  return j.id;
}

const btn = (label, href, primary) =>
  `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;${
    primary ? "background:#c8372d;color:#fff" : "background:#fff;color:#1d1d1b;border:1px solid #c9c5bd"
  }">${esc(label)}</a>`;

const actionUrl = (kind, id, action, ttl) => siteUrl() + "/agent/act?t=" + makeToken(kind, id, action, ttl);

const row = (k, v) =>
  `<tr><td style="padding:6px 12px 6px 0;color:#625f58;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${v}</td></tr>`;

const link = (label, u) => (safeUrl(u) ? `<a href="${esc(safeUrl(u))}">${esc(label)}</a>` : esc(label));

function wrap(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#fafaf8;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d1b;line-height:1.5">
<div style="max-width:640px;margin:0 auto;padding:24px">
<p style="margin:0 0 4px;color:#625f58;font-size:13px">Wufa agent</p>
<h1 style="margin:0 0 16px;font-size:20px">${esc(title)}</h1>
${bodyHtml}
<p style="margin-top:24px;color:#625f58;font-size:12px">Buttons work once. This agent only acts on its own buttons; it ignores replies and other emails.</p>
</div></body></html>`;
}

const textOf = (lines) => lines.filter(Boolean).join("\n");

/* ---------- 1. Product proposal ---------- */
export function proposalEmail(p) {
  const pr = p.pricing;
  const html = wrap("New product proposal: " + p.title, `
<table style="border-collapse:collapse;font-size:14px">
${row("Product", link(p.title, p.supplierProductUrl))}
${row("Supplier", link(p.supplier.name, p.supplier.url) + (p.supplier.registered ? " (account already set up)" : " (needs registration)"))}
${row("Why it meets eBay rules", esc(p.supplier.policyEvidence))}
${row("Dispatch", esc(p.supplier.dispatch))}
${row("Est. cost incl. VAT + delivery", gbp(pr.costPence) + (p.costIsEstimate ? " (estimate until registered)" : ""))}
${row("Selling price", "<b>" + gbp(pr.pricePence) + "</b>")}
${row("eBay fees (est.)", gbp(pr.feesPence))}
${row("Profit per sale", "<b>" + gbp(pr.profitPence) + "</b>")}
${row("Cheapest competitor", pr.competitorPence != null ? gbp(pr.competitorPence) : "none found")}
${row("Competing listings", esc(p.competition))}
${row("Demand evidence", esc(p.demand))}
${row("Check sold history", link("Open Terapeak in Seller Hub", "https://www.ebay.co.uk/sh/research?keywords=" + encodeURIComponent(p.searchTerms || p.title)))}
</table>
<p style="margin:20px 0 8px">Approve to continue, or reject to drop it.</p>
${btn("Approve", actionUrl("proposal", p.id, "approve", APPROVAL_TTL_DAYS), true)}${btn("Reject", actionUrl("proposal", p.id, "reject", APPROVAL_TTL_DAYS))}`);
  const text = textOf([
    "New product proposal: " + p.title, "Supplier: " + p.supplier.name, "Price: " + gbp(pr.pricePence), "Profit: " + gbp(pr.profitPence),
    "Open the email in HTML to approve or reject.",
  ]);
  return { subject: "Approve? " + p.title + " – " + gbp(pr.pricePence) + ", profit " + gbp(pr.profitPence), html, text };
}

/* ---------- 2. Register with supplier ---------- */
export function registerEmail(p) {
  const html = wrap("Please register with " + p.supplier.name, `
<p>You approved <b>${esc(p.title)}</b>. To check the real trade price and order it, Wufa needs an account with this supplier.</p>
<table style="border-collapse:collapse;font-size:14px">
${row("Sign-up page", link(p.supplier.signupUrl || p.supplier.url, p.supplier.signupUrl || p.supplier.url))}
${row("Account type", esc(p.supplier.accountType || "Trade / dropship account for Wufa Ltd"))}
${row("Business details", "Wufa Ltd · Company number 17441396 · registered office as on Companies House")}
${row("Notes", esc(p.supplier.signupNotes || ""))}
</table>
<p style="margin:20px 0 8px">Press the button once your account is approved (some suppliers take a day or two).</p>
${btn("Registration done", actionUrl("proposal", p.id, "registered", 14), true)}${btn("Drop this product", actionUrl("proposal", p.id, "drop", 14))}`);
  return { subject: "Register with " + p.supplier.name + " for " + p.title, html, text: "Register with " + p.supplier.name + ": " + (p.supplier.signupUrl || p.supplier.url) };
}

/* ---------- 3. Real price failed a rule ---------- */
export function priceCheckEmail(p) {
  const pr = p.pricing;
  const html = wrap("Real price check failed: " + p.title, `
<p>With the real trade price, this product breaks a rule: <b>${esc(pr.reasons.join("; "))}</b>.</p>
<table style="border-collapse:collapse;font-size:14px">
${row("Estimated cost", gbp(p.estimateCostPence))}
${row("Real cost incl. VAT + delivery", gbp(pr.costPence))}
${row("Price needed for £1.50 profit", gbp(pr.pricePence))}
${row("Profit at that price", gbp(pr.profitPence))}
${row("Cheapest competitor", pr.competitorPence != null ? gbp(pr.competitorPence) : "none found")}
</table>
<p style="margin:20px 0 8px">List anyway at ${gbp(pr.pricePence)}, or drop it.</p>
${btn("List anyway at " + gbp(pr.pricePence), actionUrl("proposal", p.id, "list-anyway", APPROVAL_TTL_DAYS), true)}${btn("Drop it", actionUrl("proposal", p.id, "drop", APPROVAL_TTL_DAYS))}`);
  return { subject: "Price check failed: " + p.title, html, text: "Price check failed for " + p.title + ": " + pr.reasons.join("; ") };
}

/* ---------- 4. Order pack ---------- */
export function orderPackEmail(o) {
  const a = o.shipTo;
  const addr = [a.name, a.line1, a.line2, a.city, a.postcode, a.country].filter(Boolean).map(esc).join("<br>");
  const html = wrap("Order to place: " + o.title, `
<p>A customer bought this on <b>${esc(o.channel)}</b> (order ${esc(o.channelOrderId)}). Place it with the supplier and pay with your own account.</p>
<table style="border-collapse:collapse;font-size:14px">
${row("Supplier product", link(o.title, o.supplierProductUrl))}
${row("Supplier", link(o.supplierName, o.supplierUrl))}
${row("Quantity", esc(o.quantity))}
${row("Deliver to", "<div style=\"font-family:ui-monospace,Menlo,Consolas,monospace;background:#fff;border:1px solid #e4e1da;border-radius:8px;padding:10px 12px\">" + addr + "</div>")}
${row("Phone", esc(a.phone || "–"))}
${row("Customer paid", gbp(o.paidPence))}
${row("Expected supplier cost", gbp(o.expectedCostPence))}
${row("Expected profit", gbp(o.expectedProfitPence))}
${row("Dispatch deadline", esc(o.dispatchBy))}
</table>
<p style="margin:16px 0 8px;font-size:13px;color:#625f58">Before paying, check the supplier's price hasn't gone up and that the delivery address and name match exactly.</p>
${btn("Paid – enter tracking", actionUrl("order", o.id, "paid", ORDER_TTL_DAYS), true)}${btn("Can't fulfil", actionUrl("order", o.id, "cant-fulfil", ORDER_TTL_DAYS))}`);
  const text = textOf([
    "Order to place: " + o.title, "Supplier product: " + safeUrl(o.supplierProductUrl), "Quantity: " + o.quantity,
    "Deliver to:", a.name, a.line1, a.line2, a.city, a.postcode, a.country, "Phone: " + (a.phone || "-"),
  ]);
  return { subject: "Order to place: " + o.title + " × " + o.quantity + " (" + o.channel + ")", html, text };
}
