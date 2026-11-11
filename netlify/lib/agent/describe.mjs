// Turns the supplier's product description (HTML or plain text) into a clean eBay description:
// keeps the paragraphs and bullet lists, drops links/styles, and removes trade-only sentences
// ("these will definitely sell", "dropshipping", supplier names) that buyers shouldn't see.
import { esc } from "./email.mjs";

// Supplier names are cut out of a sentence; sentences that talk to retailers are dropped.
const NAMES = /\b(ancient wisdom|aw)( dropship(ping)?| wholesale| ltd)?\b|\bsomething different( wholesale)?\b/gi;
const TRADE = /dropship|wholesale|retailer|stockist|resell|your (customers|shop|store)|will (definitely |surely )?(sell|fly)|best ?seller for|profit|margin|trade (price|customers?)|\bRRP\b|minimum order|units? per outer|outer of/i;

const decode = (s) => String(s)
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
  .replace(/&ldquo;|&rdquo;/gi, '"').replace(/&ndash;/gi, "–").replace(/&mdash;/gi, "—").replace(/&pound;/gi, "£").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const tidy = (s) => decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const cleanSentences = (s) => {
  const parts = tidy(s).replace(NAMES, " ").replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).map((x) => x.trim().replace(/^[a-z]/, (c) => c.toUpperCase()));
  return parts.filter((x) => x && !TRADE.test(x)).join(" ").trim();
};

/** Returns [{ p: "text" } | { ul: ["item", ...] }] */
export function blocks(raw) {
  let s = String(raw || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  if (!s.trim()) return [];
  const out = [];
  if (!/<\w+/.test(s)) {
    for (const para of s.split(/\n\s*\n|\r\n\s*\r\n|\n/)) { const t = cleanSentences(para); if (t.length > 2) out.push({ p: t }); }
    return out;
  }
  // Lists first (kept as bullet points), then split the rest on block tags.
  s = s.replace(/<(ul|ol)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => {
    const items = [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => cleanSentences(m[1])).filter((x) => x.length > 1);
    return items.length ? "\u0000UL" + JSON.stringify(items) + "\u0000" : "";
  });
  for (const chunk of s.split(/<\/?(?:p|div|h[1-6]|br|tr|table)[^>]*>|\u0000/i)) {
    if (chunk.startsWith("UL[")) { try { out.push({ ul: JSON.parse(chunk.slice(2)) }); } catch {} continue; }
    const t = cleanSentences(chunk);
    if (t.length > 2) out.push({ p: t });
  }
  return out;
}

/** Builds the eBay description. Returns { html, text }. */
export function buildDescription({ title, q, supplier }) {
  const b = blocks(q.descriptionHtml || q.description);
  const facts = [
    q.material && ["Material", q.material],
    q.dimensions && ["Size", q.dimensions],
    q.weightKg > 0 && ["Weight", q.weightKg < 1 ? Math.round(q.weightKg * 1000) + " g" : q.weightKg.toFixed(2).replace(/\.?0+$/, "") + " kg"],
    ["Condition", "Brand new"],
  ].filter(Boolean);
  const disp = supplier.dispatchDays;
  const delivery = [`Dispatched within ${disp} working day${disp > 1 ? "s" : ""} from our UK warehouse`, "Free tracked UK delivery", "Securely packed"];
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:820px">
<h2 style="font-size:21px;margin:0 0 12px">${esc(title)}</h2>
${b.map((x) => x.ul ? "<ul>" + x.ul.map((i) => "<li>" + esc(i) + "</li>").join("") + "</ul>" : "<p>" + esc(x.p) + "</p>").join("\n") || "<p>" + esc(title) + "</p>"}
<h3 style="font-size:17px;margin:18px 0 6px">Product details</h3>
<ul>${facts.map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join("")}</ul>
<h3 style="font-size:17px;margin:18px 0 6px">Delivery</h3>
<ul>${delivery.map((d) => "<li>" + esc(d) + "</li>").join("")}</ul>
<p style="color:#555;font-size:13px">Colours may vary slightly from the photos depending on your screen. Any questions – just send us a message.</p>
</div>`;
  const text = [title, ...b.map((x) => x.ul ? x.ul.map((i) => "• " + i).join("\n") : x.p), facts.map(([k, v]) => k + ": " + v).join("\n"), delivery.join(". ") + "."].join("\n\n");
  return { html, text };
}
