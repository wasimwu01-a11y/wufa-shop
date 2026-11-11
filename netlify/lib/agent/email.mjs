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
${p.image && /^https:\/\//.test(p.image) ? `<p><img src="${esc(p.image)}" alt="" width="220" style="max-width:100%;border-radius:8px;border:1px solid #e4e1da"></p>` : ""}
<table style="border-collapse:collapse;font-size:14px">
${row("Product", link(p.title, p.supplierProductUrl) + (p.sku ? " <span style=\"color:#625f58\">(" + esc(p.sku) + ")</span>" : ""))}
${row("Supplier", link(p.supplier.name, p.supplier.url) + (p.supplier.registered ? " (account already set up)" : " (needs registration)"))}
${row("Why it meets eBay rules", esc(p.supplier.policyEvidence))}
${row("Dispatch", esc(p.supplier.dispatch))}
${p.deliveryDaysMax ? row("Delivery time to show", (p.dispatchDays != null ? "dispatch in " + esc(p.dispatchDays) + " working day(s), " : "") + "delivered within <b>" + esc(p.deliveryDaysMax) + " working days</b>" + (p.deliveryEvidence ? " – " + esc(p.deliveryEvidence) : "")) : ""}
${p.supplier.payment ? row("Payment", esc(p.supplier.payment)) : ""}
${p.supplier.signupNotes ? row("Account terms", esc(p.supplier.signupNotes)) : ""}
${p.supplier.blindShipping ? row("Unbranded parcels", esc(p.supplier.blindShipping)) : ""}
${p.supplier.returns ? row("Supplier returns", esc(p.supplier.returns)) : ""}
${row("Cost incl. VAT + delivery", gbp(pr.costPence) + (p.costIsEstimate ? " <i>(estimate until you register)</i>" : ""))}
${p.costEvidence ? row("Cost based on", esc(p.costEvidence)) : ""}
${row("Selling price", "<b>" + gbp(pr.pricePence) + "</b>")}
${row("eBay fees (est.)", gbp(pr.feesPence) + (p.feeEvidence ? " – " + esc(p.feeEvidence) : ""))}
${row("Profit per sale", "<b>" + gbp(pr.profitPence) + "</b>")}
${row("Cheapest competitor", pr.competitorPence != null ? gbp(pr.competitorPence) + " incl. postage" : "none found")}
${row("Competition", esc(p.competition))}
${row("Demand evidence", esc(p.demand))}
${p.risks ? row("Risks", esc(p.risks)) : ""}
${row("Check sold history", link("Open Terapeak in Seller Hub", "https://www.ebay.co.uk/sh/research?keywords=" + encodeURIComponent(p.searchTerms || p.title)))}
${p.sources?.length ? row("Sources", p.sources.map((u, i) => link("source " + (i + 1), u)).join(" · ")) : ""}
${p.run ? row("Research cost", "about $" + Number(p.run.costUSD).toFixed(2) + " (" + esc(p.run.usage.searches) + " searches, " + esc(p.run.usage.fetches) + " pages read)") : ""}
</table>
<p style="margin:20px 0 8px">Approve to continue, or reject to drop it.</p>
${btn("Approve", actionUrl("proposal", p.id, "approve", APPROVAL_TTL_DAYS), true)}${btn("Reject", actionUrl("proposal", p.id, "reject", APPROVAL_TTL_DAYS))}
${p.source !== "catalog" ? `<p style="margin:14px 0 6px;font-size:13px;color:#625f58">This product came from internet research.</p>${btn("Stop internet research", actionUrl("agent", "settings", "stop-research", 30))}` : ""}`);
  const text = textOf([
    "New product proposal: " + p.title, "Supplier: " + p.supplier.name, "Price: " + gbp(pr.pricePence), "Profit: " + gbp(pr.profitPence),
    "Open the email in HTML to approve or reject.",
  ]);
  return { subject: "Approve? " + p.title + " – " + gbp(pr.pricePence) + ", profit " + gbp(pr.profitPence), html, text };
}

/* ---------- 2. Register with supplier ---------- */
export function registerEmail(p) {
  if (p.supplier.registered) {
    const html = wrap("Enter the trade price: " + p.title, `
<p>You approved <b>${esc(p.title)}</b>. You already have an account with ${link(p.supplier.name, p.supplier.url)}. Log in, find the item and enter its real trade price and delivery charge.</p>
<p>${link("Open the product at the supplier", p.supplierProductUrl)}</p>
${btn("Enter trade price", actionUrl("proposal", p.id, "registered", 14), true)}${btn("Drop this product", actionUrl("proposal", p.id, "drop", 14))}`);
    return { subject: "Enter trade price: " + p.title, html, text: "Enter the trade price for " + p.title };
  }
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

/* ---------- 5. Listing queue is empty ---------- */
export function queueEmptyEmail({ counts = {}, detail = "" }) {
  const c = (k) => counts[k] || 0;
  const html = wrap("The listing queue has run out", `
<p>There are no products left in the listing queue${detail ? " (" + esc(detail) + ")" : ""}. So far: <b>${c("approved")}</b> approved, <b>${c("rejected")}</b> rejected, <b>${c("failed_recheck")}</b> dropped because eBay prices moved.</p>
<p style="margin:16px 0 6px"><b>Option 1 – add more products (free).</b> Download fresh product files from Something Different and AW (or a new supplier), open your screener page (<i>/agent/screener</i> with your key), run it and add the winners to the queue. Proposals restart automatically.</p>
<p style="margin:16px 0 6px"><b>Option 2 – let the agent research the internet</b> for new UK suppliers and products. This uses your Anthropic credit (capped at the daily budget) and every product still needs your approval.</p>
${btn("Allow internet research", actionUrl("agent", "settings", "allow-research", 14), true)}${btn("Not now – I'll add products", actionUrl("agent", "settings", "decline-research", 14))}`);
  return { subject: "Wufa agent: listing queue is empty – what next?", html, text: "The listing queue is empty. Add products with the screener, or allow internet research from the email buttons." };
}

/* ---------- 6. Listed / listing failed ---------- */
export function listedEmail(p, r) {
  const html = wrap("Listed on eBay: " + (p.listingTitle || p.title), `
<table style="border-collapse:collapse;font-size:14px">
${row("Listing", link("View on eBay (item " + r.listingId + ")", r.url))}
${row("Price", "<b>" + gbp(p.pricing.pricePence) + "</b> with free UK postage")}
${row("Profit per sale", gbp(p.pricing.profitPence))}
${row("Quantity listed", esc(r.quantity))}
${row("Category", esc(r.categoryName))}
${row("Your eBay SKU", esc(r.sku))}
</table>
<p style="font-size:13px;color:#625f58">When it sells, you'll get an order pack email to place the order with ${esc(p.supplier.name)} (Phase 5). Until then, check Seller Hub for orders.</p>`);
  return { subject: "Listed on eBay: " + (p.listingTitle || p.title) + " – " + gbp(p.pricing.pricePence), html, text: "Listed: " + r.url };
}
export function listFailedEmail(p, e) {
  const html = wrap("Couldn't list on eBay: " + (p.listingTitle || p.title), `
<p><b>What happened:</b> ${esc(e.message)}</p>
${e.fix ? `<p><b>How to fix it:</b> ${esc(e.fix)}</p>` : ""}
<p style="margin:16px 0 8px">Once fixed, press Try again (you can also edit the title on the next page).</p>
${btn("Try again", actionUrl("proposal", p.id, "retry-list", 30), true)}${btn("Drop this product", actionUrl("proposal", p.id, "drop", 30))}`);
  return { subject: "Couldn't list on eBay: " + (p.listingTitle || p.title), html, text: "Listing failed: " + e.message + (e.fix ? " – " + e.fix : "") };
}
export function reconnectEmail(expires) {
  const html = wrap("Please reconnect eBay selling access", `<p>The agent's access to your eBay account expires on <b>${esc(String(expires).slice(0, 10))}</b>. Open your connect page (<i>/agent/ebay-connect</i> with your key) and sign in to eBay again – it takes a minute.</p>`);
  return { subject: "Wufa agent: reconnect eBay before " + String(expires).slice(0, 10), html, text: "Reconnect eBay selling access before " + expires };
}
