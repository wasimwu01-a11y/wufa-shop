// /agent/act?t=<token>  – the page behind every email button.
// GET shows what will happen and asks to confirm (so email link-scanners that "open" links can't trigger anything);
// POST does it. Each item only accepts an action that fits its current status.
import { checkToken, spendToken } from "../lib/agent/tokens.mjs";
import { getJSON, update } from "../lib/agent/store.mjs";
import { sendEmail, registerEmail, esc } from "../lib/agent/email.mjs";
import { gbp } from "../lib/agent/pricing.mjs";

const ALLOWED = {
  proposal: {
    approve: ["awaiting_approval"],
    reject: ["awaiting_approval"],
    drop: ["awaiting_registration", "price_failed"],
    registered: ["awaiting_registration"],
    "list-anyway": ["price_failed"],
  },
  order: {
    paid: ["awaiting_payment"],
    "cant-fulfil": ["awaiting_payment"],
  },
};

const LABEL = {
  approve: "Approve this product",
  reject: "Reject this product",
  drop: "Drop this product",
  registered: "Confirm supplier registration is done",
  "list-anyway": "List anyway at the higher price",
  paid: "Confirm you've paid the supplier",
  "cant-fulfil": "Mark this order as can't fulfil",
};

const CARRIERS = ["Royal Mail", "Evri", "DPD", "DHL", "Parcelforce", "Yodel", "UPS", "Other"];

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>:root{--bg:#fafaf8;--card:#fff;--text:#1d1d1b;--muted:#625f58;--line:#e4e1da;--accent:#c8372d}@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#201f1d;--text:#f2f0eb;--muted:#a9a59c;--line:#34322e}}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5}
.w{max-width:560px;margin:0 auto;padding:32px 16px}.c{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
h1{font-size:1.3rem;margin:0 0 12px}p{margin:0 0 12px}.m{color:var(--muted);font-size:.9rem}
button{font:inherit;font-weight:600;padding:12px 20px;border-radius:8px;border:0;background:var(--accent);color:#fff;cursor:pointer}
label{display:block;font-weight:600;margin:12px 0 4px}input,select{font:inherit;width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 16px}dt{color:var(--muted)}dd{margin:0}</style></head>
<body><div class="w"><div class="c">${body}</div><p class="m" style="margin-top:12px">Wufa agent</p></div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } }
  );
}

const fail = (msg, status = 400) => page("Can't do that", `<h1>Can't do that</h1><p>${esc(msg)}</p>`, status);

async function load(t) {
  const item = await getJSON(t.k + "/" + t.id);
  if (!item) throw new Error("This item no longer exists.");
  const ok = ALLOWED[t.k]?.[t.a];
  if (!ok) throw new Error("Unknown action.");
  if (!ok.includes(item.status)) throw new Error(`This was already handled (current status: ${item.status.replace(/_/g, " ")}).`);
  return item;
}

function summary(t, item) {
  if (t.k === "proposal")
    return `<dl><dt>Product</dt><dd>${esc(item.title)}</dd><dt>Supplier</dt><dd>${esc(item.supplier?.name)}</dd><dt>Price</dt><dd>${gbp(item.pricing.pricePence)}</dd><dt>Profit</dt><dd>${gbp(item.pricing.profitPence)}</dd></dl>`;
  return `<dl><dt>Item</dt><dd>${esc(item.title)} × ${esc(item.quantity)}</dd><dt>Channel</dt><dd>${esc(item.channel)} order ${esc(item.channelOrderId)}</dd><dt>Customer</dt><dd>${esc(item.shipTo?.name)}, ${esc(item.shipTo?.postcode)}</dd></dl>`;
}

export default async (req) => {
  const url = new URL(req.url);
  let token = url.searchParams.get("t");
  let form = null;
  if (req.method === "POST") {
    form = await req.formData();
    token = form.get("t");
  } else if (req.method !== "GET") return fail("Method not allowed", 405);

  let t, item;
  try {
    t = await checkToken(token);
    item = await load(t);
  } catch (e) {
    return fail(e.message || "This link isn't valid.");
  }

  // GET → confirmation page
  if (!form) {
    const extra =
      t.a === "paid"
        ? `<label for="carrier">Carrier</label><select id="carrier" name="carrier" required>${CARRIERS.map((c) => `<option>${esc(c)}</option>`).join("")}</select>
           <label for="tracking">Tracking number</label><input id="tracking" name="tracking" required maxlength="60" pattern="[A-Za-z0-9 \\-]{6,60}" autocomplete="off">`
        : t.a === "cant-fulfil"
        ? `<label for="reason">Reason (optional)</label><input id="reason" name="reason" maxlength="200">`
        : "";
    return page(LABEL[t.a], `<h1>${esc(LABEL[t.a])}?</h1>${summary(t, item)}
<form method="post" action="/agent/act"><input type="hidden" name="t" value="${esc(token)}">${extra}<p style="margin-top:16px"><button type="submit">Confirm</button></p></form>`);
  }

  // POST → do it
  let note, changes, after = "";
  try {
    switch (`${t.k}:${t.a}`) {
      case "proposal:approve":
        if (item.supplier?.registered) {
          changes = { status: "checking_price" };
          note = "Approved; supplier account exists";
          after = "The agent will check the real price and list it if it still makes at least £1.50.";
        } else {
          changes = { status: "awaiting_registration" };
          note = "Approved; registration requested";
          after = "You'll get an email with the supplier sign-up details shortly.";
        }
        break;
      case "proposal:reject":
      case "proposal:drop":
        changes = { status: "rejected" };
        note = t.a === "drop" ? "Dropped" : "Rejected";
        after = "Dropped. The agent will look for something else in its next run.";
        break;
      case "proposal:registered":
        changes = { status: "checking_price", supplier: { ...item.supplier, registered: true } };
        note = "Supplier registration confirmed";
        after = "The agent will now check the real trade price.";
        break;
      case "proposal:list-anyway":
        changes = { status: "ready_to_list" };
        note = "Approved at higher price";
        after = "It will be listed at " + gbp(item.pricing.pricePence) + ".";
        break;
      case "order:paid": {
        const tracking = String(form.get("tracking") || "").trim().toUpperCase();
        const carrier = String(form.get("carrier") || "");
        if (!/^[A-Z0-9 \-]{6,60}$/.test(tracking) || !CARRIERS.includes(carrier)) return fail("Please enter a valid carrier and tracking number.");
        changes = { status: "paid_awaiting_sync", tracking, carrier };
        note = `Paid; ${carrier} ${tracking}`;
        after = `Tracking ${tracking} saved. It will be sent to ${item.channel === "eBay" ? "eBay" : "the customer"} automatically.`;
        break;
      }
      case "order:cant-fulfil":
        changes = { status: "cancel_requested", cancelReason: String(form.get("reason") || "").slice(0, 200) };
        note = "Can't fulfil";
        after = "The agent will cancel and refund the order and pause the listing.";
        break;
    }
    const saved = await update(t.k + "/" + t.id, changes, note);
    await spendToken(t);
    if (t.k === "proposal" && changes.status === "awaiting_registration") {
      await sendEmail(registerEmail(saved));
      await update(t.k + "/" + t.id, {}, "Registration email sent");
    }
  } catch (e) {
    console.error(e);
    return fail("Something went wrong saving that. Please try the button again in a minute.", 500);
  }
  return page("Done", `<h1>Done</h1><p>${esc(after)}</p>`);
};

export const config = { path: "/agent/act" };
