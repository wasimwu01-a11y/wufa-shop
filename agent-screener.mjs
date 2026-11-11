// /agent/screener?key=<AGENT_SECRET>
// Upload supplier product files → the browser reads them → this function filters & prices each product,
// checks the survivors against live eBay prices, and adds the chosen winners to the agent's listing queue.
// Big files never leave your browser in one piece: they're sent in small batches.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { exclusion, quote, notes, queueKey, SUPPLIERS } from "../lib/agent/catalog.mjs";
import { ebayMatch } from "../lib/agent/competitors.mjs";
import { getJSON, setJSON, listKeys, getAll, update } from "../lib/agent/store.mjs";
import { startListing } from "../lib/agent/trigger.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const clean = (it) => ({
  supplier: it.supplier === "aw" ? "aw" : "sd",
  sku: String(it.sku || "").slice(0, 60),
  name: String(it.name || "").slice(0, 200),
  category: String(it.category || "").slice(0, 120),
  department: String(it.department || "").slice(0, 60),
  priceExVat: Number(it.priceExVat) || 0,
  rrp: Number(it.rrp) || 0,
  weightKg: Number(it.weightKg) || 0,
  stock: Number(it.stock) || 0,
  moq: Number(it.moq) || 1,
  discontinued: !!it.discontinued,
  status: String(it.status || ""), forSale: String(it.forSale || ""), stockFlag: String(it.stockFlag || ""),
  barcode: String(it.barcode || "").slice(0, 20),
  material: String(it.material || "").slice(0, 80),
  image: /^https:\/\//.test(it.image || "") ? String(it.image).slice(0, 500) : "",
  images: (Array.isArray(it.images) ? it.images : []).filter((x) => /^https:\/\//.test(x || "")).map((x) => String(x).slice(0, 500)).slice(0, 12),
  description: String(it.description || "").slice(0, 4000),
  descriptionHtml: String(it.descriptionHtml || "").slice(0, 8000),
  dimensions: String(it.dimensions || "").slice(0, 60),
});
const DETAIL_FIELDS = ["images", "image", "description", "descriptionHtml", "dimensions", "material"];

async function op(body) {
  const items = (body.items || []).slice(0, body.op === "check" ? 5 : body.op === "queue" || body.op === "refresh" ? 50 : 600).map(clean);
  if (body.op === "refresh") {
    // Updates photos/description of products already in the queue; listed ones are re-sent to eBay.
    let updated = 0; const relist = [];
    await Promise.all(items.map(async (it) => {
      const k = queueKey(it); const cur = await getJSON(k);
      if (!cur || cur.status === "removed") return;
      const patch = Object.fromEntries(DETAIL_FIELDS.filter((f) => it[f] && (Array.isArray(it[f]) ? it[f].length : true)).map((f) => [f, it[f]]));
      await setJSON(k, { ...cur, ...patch, detailsUpdatedAt: new Date().toISOString() });
      updated++;
      if (cur.status === "listed") relist.push(k);
    }));
    let resent = 0;
    if (relist.length) {
      for (const { k: pk, v: pr } of await getAll("proposal/")) {
        if (pr.status === "listed" && relist.includes(pr.queueKey)) { await update(pk, { status: "ready_to_list", revise: true }, "Photos/description refreshed – updating eBay listing"); resent++; }
      }
      if (resent) await startListing().catch(() => {});
    }
    return { updated, resent };
  }
  if (body.op === "prepare") {
    return {
      results: items.map((it) => {
        const why = exclusion(it);
        if (why) return { ref: it.supplier + ":" + it.sku, excluded: why };
        const q = quote(it);
        return { ref: it.supplier + ":" + it.sku, pricePence: q.pricePence, costPence: q.costPence, deliveryGBP: q.deliveryGBP, rrpPence: q.rrpPence, passesRrp: q.passesRrp, notes: notes(it) };
      }),
    };
  }
  if (body.op === "check") {
    const out = await Promise.all(items.map(async (it) => {
      const m = await ebayMatch({ name: it.name, barcode: it.barcode }).catch((e) => ({ checked: false, reason: String(e.message || e) }));
      if (!m.checked) return { ref: it.supplier + ":" + it.sku, checked: false, reason: m.reason };
      const q = quote(it, m.cheapest);
      return { ref: it.supplier + ":" + it.sku, checked: true, pass: q.ok, reasons: q.reasons, pricePence: q.pricePence, profitPence: q.profitPence,
        cheapest: m.cheapest, count: m.count, top: m.top, searchUrl: m.searchUrl, headroomPence: m.cheapest != null ? Math.round(m.cheapest * 100) - q.pricePence : null };
    }));
    return { results: out };
  }
  if (body.op === "queue") {
    let added = 0;
    for (const it of items) {
      if (exclusion(it)) continue;
      const s = body.screened?.[it.supplier + ":" + it.sku] || {};
      const k = queueKey(it);
      const cur = await getJSON(k);
      if (cur && cur.status !== "removed") continue;
      await setJSON(k, { ...it, notes: notes(it), screened: { at: new Date().toISOString(), cheapest: s.cheapest ?? null, count: s.count ?? null, searchUrl: s.searchUrl || "", top: (s.top || []).slice(0, 3), headroomPence: s.headroomPence ?? null },
        status: "queued", addedAt: new Date().toISOString() });
      added++;
    }
    if (added) { const m = (await getJSON("meta/agent")) || {}; if (m.queueEmptyNotifiedAt) await setJSON("meta/agent", { ...m, queueEmptyNotifiedAt: null }); }
    return { added, queued: await queuedCount() };
  }
  if (body.op === "queueList") {
    const list = [];
    for (const { k, v: q } of await getAll("queue/")) { list.push({ key: k, sku: q.sku, name: q.name, supplier: q.supplier, status: q.status, headroomPence: q.screened?.headroomPence ?? null }); }
    return { list };
  }
  if (body.op === "queueRemove") {
    const k = String(body.key || "");
    if (!k.startsWith("queue/")) return { error: "bad key" };
    const q = await getJSON(k);
    if (q && q.status === "queued") await setJSON(k, { ...q, status: "removed" });
    return { ok: true, queued: await queuedCount() };
  }
  return { error: "unknown op" };
}

export async function queuedCount() {
  let n = 0;
  for (const { v } of await getAll("queue/")) if (v.status === "queued") n++;
  return n;
}

export default async (req) => {
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (!env("AGENT_SECRET") || !same(body.key || "", env("AGENT_SECRET"))) return json({ error: "Not found" }, 404);
    try { return json(await op(body)); } catch (e) { console.error(e); return json({ error: "Server error: " + (e.message || e) }, 500); }
  }
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!env("AGENT_SECRET") || !same(key, env("AGENT_SECRET"))) return new Response("Not found", { status: 404 });
  return new Response(PAGE.replace("__KEY__", JSON.stringify(key).replace(/</g, "\\u003c")).replace("__QUEUED__", String(await queuedCount())),
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
};

export const config = { path: "/agent/screener" };

const PAGE = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Product screener</title>
<style>:root{--bg:#fafaf8;--card:#fff;--text:#1d1d1b;--muted:#625f58;--line:#e4e1da;--accent:#c8372d;--ok:#1f8a4c}@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#201f1d;--text:#f2f0eb;--muted:#a9a59c;--line:#34322e}}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.45}
.w{max-width:1100px;margin:0 auto;padding:24px 16px}.c{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 14px}
h1{font-size:1.35rem;margin:0 0 6px}.m{color:var(--muted);font-size:.9rem}label{display:block;font-weight:600;margin:10px 0 4px}
button{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:0;background:var(--accent);color:#fff;cursor:pointer}button.s{background:transparent;color:var(--text);border:1px solid var(--line)}button:disabled{opacity:.5;cursor:default}
.bar{height:8px;background:var(--line);border-radius:99px;overflow:hidden;margin:10px 0}.bar i{display:block;height:100%;width:0;background:var(--ok);transition:width .2s}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.86rem}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{position:sticky;top:0;background:var(--card);cursor:pointer;white-space:nowrap}
td.n{text-align:right;white-space:nowrap}.ok{color:var(--ok);font-weight:700}.no{color:var(--accent)}img.t{width:44px;height:44px;object-fit:cover;border-radius:6px;background:#fff}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}a{color:inherit}</style></head><body><div class="w">
<h1>Product screener</h1><p class="m">Pick the supplier files (Something Different "DropshipStockFull.txt" and/or AW "shop_awd.csv"). Products are filtered for your rules, priced with VAT and delivery for £1.50 profit, then checked against live eBay UK prices. Nothing is listed until you approve it by email.</p>
<div class="c"><label for="f">Supplier files</label><input id="f" type="file" multiple accept=".csv,.txt,.tsv">
<div class="row" style="margin-top:12px"><button id="go">Run screener</button><button class="s" id="rf">Update photos &amp; descriptions of queued/listed products</button><span class="m" id="st"></span></div><div class="bar"><i id="pb"></i></div>
<p class="m" id="sum"></p></div>
<div class="c" id="res" hidden><div class="row"><b id="rt"></b><label style="margin:0;font-weight:400"><input type="checkbox" id="onlyPass" checked> show passes only</label>
<button class="s" id="top">Select top 20</button><button class="s" id="all">Select all passes</button><button class="s" id="none">Clear</button><button id="q">Add selected to listing queue</button><button class="s" id="dl">Download results (CSV)</button><span class="m">Queue: <b id="qn">__QUEUED__</b> products waiting</span></div>
<div class="tw" style="max-height:70vh;margin-top:10px"><table><thead><tr><th></th><th></th><th data-k="name">Product</th><th data-k="supplier">Supplier</th><th data-k="cost" class="n">Cost+del.</th><th data-k="price" class="n">Your price</th><th data-k="cheapest" class="n">Cheapest eBay</th><th data-k="headroom" class="n">Headroom</th><th data-k="count" class="n">Rivals</th><th>Notes</th></tr></thead><tbody id="tb"></tbody></table></div></div>
<script>
const KEY = __KEY__;
const $ = (id) => document.getElementById(id);
const gbp = (p) => p == null ? "–" : "£" + (p / 100).toFixed(2);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = (x) => { const v = parseFloat(String(x == null ? "" : x).replace(/,/g, "")); return isFinite(v) ? v : 0; };

// Robust CSV/TSV parser (quoted fields, commas and line breaks inside quotes).
function parse(text, d) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f === "") q = true;
    else if (c === d) { row.push(f); f = ""; }
    else if (c === "\\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\\r") f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  const h = rows.shift().map((s) => s.trim());
  return rows.filter((r) => r.length > 3).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] == null ? "" : r[i]])));
}
const imgs = (v) => String(v || "").split(/[,|\\s]+/).map((x) => x.trim()).filter((x) => /^https:\\/\\//.test(x)).slice(0, 12);
function normalise(text) {
  const first = text.slice(0, text.indexOf("\\n"));
  const rows = parse(text.replace(/^\\uFEFF/, ""), first.includes("\\t") ? "\\t" : ",");
  if (!rows.length) return [];
  if ("Item No" in rows[0]) return rows.map((r) => ({ supplier: "sd", sku: r["Item No"], name: r["Item Name"], category: "", priceExVat: num(r["Price"]), rrp: num(r["RRP"]),
    weightKg: (num(r["Packed Weight"]) || num(r["Individual Weight"])) / 1000, stock: num(r["Stock Level"]), moq: num(r["Min Order Qty"]) || 1,
    discontinued: String(r["Discontinued"]).trim().toLowerCase() === "true", barcode: r["Barcode"], material: r["Material"], images: imgs(r["URL Links"]), image: imgs(r["URL Links"])[0] || "", description: r["Online Description"],
    dimensions: [r["Height"], r["Width"], r["Depth"]].map(num).filter((x) => x > 0).length === 3 ? "H " + num(r["Height"]) + " x W " + num(r["Width"]) + " x D " + num(r["Depth"]) + " cm" : "" }));
  if ("Product code" in rows[0]) return rows.map((r) => ({ supplier: "aw", sku: r["Product code"], name: r["Unit Name"], category: (r["Department"] || "") + " > " + (r["Subdepartment"] || ""), department: r["Department"],
    priceExVat: num(r["Unit price"]), rrp: num(r["Unit RRP"]), weightKg: num(r["Package weight (shipping)"]), stock: num(r["Available Quantity"]), moq: num(r["Units per outer"]) || 1,
    status: r["Status"], forSale: r["For sale"], stockFlag: r["Stock"], barcode: r["Barcode"], material: r["Materials/Ingredients"], images: imgs(r["Images"]), image: imgs(r["Images"])[0] || "", description: r["Webpage description (plain text)"],
    descriptionHtml: r["Webpage description (html)"], dimensions: (r["Unit dimensions"] || "").trim() }));
  throw new Error("Unrecognised file: expected Something Different (Item No…) or AW (Product code…) columns");
}
async function call(op, items, extra) {
  for (let a = 0; a < 3; a++) {
    try { const r = await fetch("/agent/screener", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: KEY, op, items, ...(extra || {}) }) });
      const j = await r.json(); if (r.ok) return j; throw new Error(j.error || r.status); }
    catch (e) { if (a === 2) throw e; await new Promise((res) => setTimeout(res, 1500 * (a + 1))); }
  }
}
let rows = [], sortK = "headroom", sortDir = -1;
function render() {
  const only = $("onlyPass").checked;
  const list = rows.filter((r) => !only || r.pass).sort((a, b) => { const x = a[sortK], y = b[sortK]; return (x == null) - (y == null) || (x > y ? 1 : x < y ? -1 : 0) * sortDir; });
  $("rt").textContent = rows.filter((r) => r.pass).length + " pass eBay check · " + rows.length + " checked";
  $("tb").innerHTML = list.slice(0, 1500).map((r) => '<tr><td>' + (r.pass ? '<input type="checkbox" data-ref="' + esc(r.ref) + '"' + (r.sel ? " checked" : "") + '>' : "") + '</td><td>' + (r.image ? '<img class="t" loading="lazy" src="' + esc(r.image) + '" alt="">' : "") + '</td><td>' + esc(r.name) + '<div class="m">' + esc(r.sku) + (r.searchUrl ? ' · <a target="_blank" rel="noopener" href="' + esc(r.searchUrl) + '">eBay search</a>' : "") + (r.top && r.top[0] ? ' · <a target="_blank" rel="noopener" href="' + esc(r.top[0].url) + '">cheapest match</a>' : "") + '</div></td><td>' + (r.supplier === "aw" ? "AW" : "Something Different") + '</td><td class="n">' + gbp(r.cost) + '</td><td class="n">' + gbp(r.price) + '</td><td class="n">' + (r.cheapest == null ? (r.checked ? "none found" : esc(r.reason || "–")) : gbp(r.cheapest)) + '</td><td class="n ' + (r.pass ? "ok" : "no") + '">' + (r.headroom == null ? (r.pass ? "no rivals" : "–") : gbp(r.headroom)) + '</td><td class="n">' + (r.count == null ? "–" : r.count) + '</td><td class="m">' + esc((r.notes || []).join("; ")) + '</td></tr>').join("");
  $("res").hidden = false;
}
document.querySelectorAll("th[data-k]").forEach((th) => th.onclick = () => { const k = th.dataset.k; sortDir = sortK === k ? -sortDir : -1; sortK = k; render(); });
$("onlyPass").onchange = render;
$("tb").onchange = (e) => { const r = rows.find((x) => x.ref === e.target.dataset.ref); if (r) r.sel = e.target.checked; };
$("all").onclick = () => { rows.forEach((r) => r.sel = !!r.pass); render(); };
$("none").onclick = () => { rows.forEach((r) => r.sel = false); render(); };
$("top").onclick = () => { rows.forEach((r) => r.sel = false); rows.filter((r) => r.pass).sort((a, b) => (b.headroom ?? -1) - (a.headroom ?? -1)).slice(0, 20).forEach((r) => r.sel = true); render(); };
$("go").onclick = async () => {
  const files = [...$("f").files]; if (!files.length) { $("st").textContent = "Choose at least one file."; return; }
  $("go").disabled = true; rows = [];
  try {
    let items = [];
    for (const f of files) { $("st").textContent = "Reading " + f.name + "…"; items = items.concat(normalise(await f.text())); }
    const byRef = new Map(items.map((it) => [it.supplier + ":" + it.sku, it]));
    let cands = [], excl = 0, rrpFail = 0;
    for (let i = 0; i < items.length; i += 500) {
      $("st").textContent = "Applying your rules… " + Math.min(i + 500, items.length) + " / " + items.length; $("pb").style.width = (i / items.length * 30) + "%";
      const j = await call("prepare", items.slice(i, i + 500));
      for (const r of j.results) { if (r.excluded) excl++; else if (!r.passesRrp) rrpFail++; else cands.push({ ...r, it: byRef.get(r.ref) }); }
    }
    $("sum").textContent = items.length + " products read · " + excl + " not allowed (regulated, multipack, low stock, heavy…) · " + rrpFail + " can't make £1.50 at the supplier's RRP · " + cands.length + " to check on eBay.";
    let done = 0; const B = 5, PAR = 3; const queue = []; for (let i = 0; i < cands.length; i += B) queue.push(cands.slice(i, i + B));
    async function worker() { while (queue.length) { const b = queue.shift(); const j = await call("check", b.map((c) => c.it)).catch((e) => ({ results: b.map((c) => ({ ref: c.ref, checked: false, reason: String(e.message || e) })) }));
      for (const r of j.results) { const c = cands.find((x) => x.ref === r.ref); const it = c.it;
        rows.push({ ref: r.ref, sku: it.sku, name: it.name, supplier: it.supplier, image: it.image, notes: c.notes, cost: c.costPence + Math.round(c.deliveryGBP * 100), price: r.pricePence || c.pricePence, cheapest: r.cheapest == null ? null : Math.round(r.cheapest * 100), headroom: r.headroomPence, count: r.count, top: r.top, searchUrl: r.searchUrl, checked: r.checked, reason: r.reason, pass: !!(r.checked && r.pass), sel: false, raw: r, it }); }
      done += b.length; $("st").textContent = "Checking eBay… " + done + " / " + cands.length; $("pb").style.width = (30 + done / cands.length * 70) + "%"; if (done % 50 < B) render(); } }
    await Promise.all(Array.from({ length: PAR }, worker));
    $("pb").style.width = "100%"; $("st").textContent = "Done."; render();
  } catch (e) { $("st").textContent = "Error: " + e.message; }
  $("go").disabled = false;
};
$("q").onclick = async () => {
  const sel = rows.filter((r) => r.sel && r.pass); if (!sel.length) { alert("Tick at least one product."); return; }
  $("q").disabled = true; let added = 0, queued = 0;
  for (let i = 0; i < sel.length; i += 50) { const b = sel.slice(i, i + 50);
    const screened = Object.fromEntries(b.map((r) => [r.ref, r.raw]));
    const j = await call("queue", b.map((r) => r.it), { screened }); added += j.added; queued = j.queued; }
  $("qn").textContent = queued; $("st").textContent = added + " added to the listing queue (" + queued + " waiting). The agent proposes one every 3 days, best first."; $("q").disabled = false;
};
$("rf").onclick = async () => {
  const files = [...$("f").files]; if (!files.length) { $("st").textContent = "Choose the supplier file(s) first."; return; }
  $("rf").disabled = true;
  try {
    let items = [];
    for (const f of files) { $("st").textContent = "Reading " + f.name + "…"; items = items.concat(normalise(await f.text())); }
    const ql = (await call("queueList", [])).list.filter((x) => x.status !== "removed");
    const want = new Set(ql.map((x) => x.supplier + ":" + String(x.sku).toUpperCase()));
    const match = items.filter((it) => want.has(it.supplier + ":" + String(it.sku).toUpperCase()));
    let updated = 0, resent = 0;
    for (let i = 0; i < match.length; i += 50) {
      $("st").textContent = "Updating photos & descriptions… " + Math.min(i + 50, match.length) + " / " + match.length;
      const j = await call("refresh", match.slice(i, i + 50)); updated += j.updated; resent += j.resent;
    }
    $("st").textContent = "Updated " + updated + " queued products." + (resent ? " " + resent + " already on eBay are being updated – you'll get an email for each." : "");
  } catch (e) { $("st").textContent = "Error: " + e.message; }
  $("rf").disabled = false;
};
$("dl").onclick = () => {
  const h = ["Supplier","SKU","Product","Cost+delivery £","Your price £","Cheapest eBay £","Headroom £","Rivals","Pass","eBay search","Notes"];
  const L = [h].concat(rows.map((r) => [r.supplier === "aw" ? "AW" : "Something Different", r.sku, r.name, (r.cost/100).toFixed(2), (r.price/100).toFixed(2), r.cheapest == null ? "" : (r.cheapest/100).toFixed(2), r.headroom == null ? "" : (r.headroom/100).toFixed(2), r.count == null ? "" : r.count, r.pass ? "yes" : "no", r.searchUrl || "", (r.notes||[]).join("; ")]));
  const csv = L.map((r) => r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "ebay-screened-products.csv"; a.click();
};
</script></div></body></html>`;
