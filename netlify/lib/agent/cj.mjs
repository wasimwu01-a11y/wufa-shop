// CJ Dropshipping (UK warehouse only): API access, product search, delivery quotes and the importer
// that turns CJ's UK-stocked products into listing-queue entries – only if they sell 100+ a month on
// eBay UK and still leave £1.50 profit after CJ's price, UK delivery, VAT, card FX fee and eBay fees.
// API docs: https://developers.cjdropshipping.com/en/api/api2/
import { env } from "./config.mjs";
import { getJSON, setJSON, listKeys } from "./store.mjs";
import { exclusion, quote, notes, queueKey } from "./catalog.mjs";
import { ebayMatch, ebayDemand } from "./competitors.mjs";
import { demandBar } from "./pipeline.mjs";

const BASE = () => env("CJ_API_BASE", "https://developers.cjdropshipping.com/api2.0/v1");
const TOKEN_KEY = "secret/cj-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const cjProblem = () => (env("CJ_API_KEY") ? null : "CJ_API_KEY is not set in Netlify");

// ---------- Access token (valid ~180 days; CJ returns the same token for 24 h, so it's stored) ----------
let tokenCache = null;
async function token(force = false) {
  if (!force && tokenCache && Date.parse(tokenCache.accessTokenExpiryDate) > Date.now() + 864e5) return tokenCache.accessToken;
  const saved = force ? null : await getJSON(TOKEN_KEY);
  if (saved && Date.parse(saved.accessTokenExpiryDate) > Date.now() + 864e5) { tokenCache = saved; return saved.accessToken; }
  let r = null;
  if (saved?.refreshToken && Date.parse(saved.refreshTokenExpiryDate) > Date.now()) {
    r = await raw("POST", "/authentication/refreshAccessToken", { refreshToken: saved.refreshToken }, false);
  }
  if (!r?.ok) r = await raw("POST", "/authentication/getAccessToken", { apiKey: env("CJ_API_KEY") }, false);
  if (!r.ok || !r.body?.data?.accessToken) throw new Error("CJ sign-in failed: " + (r.body?.message || "HTTP " + r.status) + " – check CJ_API_KEY in Netlify");
  const d = r.body.data;
  tokenCache = { accessToken: d.accessToken, accessTokenExpiryDate: d.accessTokenExpiryDate || new Date(Date.now() + 150 * 864e5).toISOString(),
    refreshToken: d.refreshToken, refreshTokenExpiryDate: d.refreshTokenExpiryDate || new Date(Date.now() + 150 * 864e5).toISOString() };
  await setJSON(TOKEN_KEY, tokenCache);
  return tokenCache.accessToken;
}

// ---------- Calls (free accounts: 1 request per second) ----------
let last = 0;
async function raw(method, path, body, auth = true) {
  const gap = Number(env("CJ_MIN_GAP_MS", "1100"));
  const wait = last + gap - Date.now(); if (wait > 0) await sleep(wait);
  last = Date.now();
  const headers = { "Content-Type": "application/json" };
  if (auth) headers["CJ-Access-Token"] = await token();
  const res = await fetch(BASE() + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch { j = { message: text.slice(0, 200) }; }
  const ok = res.ok && (j?.result === true || j?.code === 200 || j?.success === true);
  return { ok, status: res.status, body: j };
}
async function cj(method, path, body) {
  for (let i = 0; i < 4; i++) {
    let r = await raw(method, path, body);
    if (r.status === 401 || /token/i.test(r.body?.message || "") && !r.ok) { tokenCache = null; await token(true); r = await raw(method, path, body); }
    if (r.ok) return r;
    const limited = r.status === 429 || /too many|frequen|limit/i.test(r.body?.message || "");
    if (/quota|points/i.test(r.body?.message || "")) return { ...r, quota: true };
    if (!limited && r.status < 500) return r;
    await sleep(2000 * (i + 1));
  }
  return { ok: false, status: 0, body: { message: "CJ didn't respond after retries" } };
}

// ---------- Money ----------
/** GBP per USD, including a buffer for the card's foreign-exchange fee (CJ charges in USD). */
export async function usdToGbp() {
  const buffer = Number(env("CJ_FX_BUFFER", "0.03"));
  if (env("CJ_USD_GBP")) return Number(env("CJ_USD_GBP")) * (1 + buffer);
  const today = new Date().toISOString().slice(0, 10);
  const c = await getJSON("cj/fx");
  if (c?.date === today && c.rate > 0) return c.rate * (1 + buffer);
  let rate = null;
  try { const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=GBP"); rate = (await r.json())?.rates?.GBP; } catch {}
  if (!(rate > 0)) rate = c?.rate || 0.8;
  await setJSON("cj/fx", { date: today, rate });
  return rate * (1 + buffer);
}
const vat = () => (env("CJ_ADD_VAT", "1") === "0" ? 1 : 1.2);
const usd = (v) => parseFloat(String(v ?? "").split(/--|-|~/)[0]) || 0;
const gbp2 = (x) => Math.round(x * 100) / 100;

// ---------- Catalogue ----------
export async function ukProducts(page = 1) {
  const q = new URLSearchParams({ page: String(page), size: "100", countryCode: "GB", orderBy: env("CJ_ORDER_BY", "1"), sort: "desc",
    startWarehouseInventory: "5", features: "enable_category" });
  const r = await cj("GET", "/product/listV2?" + q);
  if (!r.ok) return { ok: false, error: r.body?.message || "HTTP " + r.status, quota: r.quota };
  const d = r.body.data || {};
  const list = (d.content || []).flatMap((c) => c.productList || []);
  return { ok: true, list, totalPages: d.totalPages || 0 };
}

export async function productDetail(pid) {
  const r = await cj("GET", "/product/query?" + new URLSearchParams({ pid, countryCode: "GB" }));
  return r.ok ? r.body.data : null;
}

/** Cheapest UK→UK delivery for one unit that arrives within 7 days. Returns { usd, name, days } or null. */
export async function ukDelivery(vid) {
  const r = await cj("POST", "/logistic/freightCalculate", { startCountryCode: "GB", endCountryCode: "GB", products: [{ quantity: 1, vid }] });
  if (!r.ok) return null;
  const opts = (r.body.data || []).map((o) => ({ usd: usd(o.logisticPrice), name: o.logisticName, days: Math.max(...String(o.logisticAging || "").split(/\D+/).map(Number).filter((n) => n > 0), 0) }))
    .filter((o) => o.usd >= 0 && o.days > 0 && o.days <= Number(env("CJ_MAX_DELIVERY_DAYS", "7")));
  opts.sort((a, b) => a.usd - b.usd);
  return opts[0] || null;
}

const ukStock = (v) => {
  const inv = (v.inventories || v.inventory || []).find((x) => x.countryCode === "GB");
  return inv ? Number(inv.cjInventory ?? inv.totalInventory ?? 0) : 0;
};

/** Builds a catalogue row (same shape as the supplier files) for the best UK-stocked variant of a CJ product. */
export async function cjRow(pid, fx) {
  const d = await productDetail(pid);
  if (!d) return { error: "CJ product details unavailable" };
  const vs = (d.variants || []).map((v) => ({ v, stock: ukStock(v) })).filter((x) => x.stock >= 5).sort((a, b) => b.stock - a.stock);
  if (!vs.length) return { error: "no variant with 5+ in CJ's UK warehouse" };
  const { v, stock } = vs[0];
  const ship = await ukDelivery(v.vid);
  if (!ship) return { error: "no UK→UK delivery option within 7 days" };
  const cost = gbp2(usd(v.variantSellPrice || d.sellPrice) * fx * vat());
  const name = String(d.productNameEn || d.productName || "").replace(/\s+/g, " ").trim() + (d.variants.length > 1 && v.variantNameEn ? " – " + v.variantNameEn.replace(/^.*?-\s*/, "") : "");
  const images = [...new Set([v.variantImage, d.bigImage, ...(Array.isArray(d.productImageSet) ? d.productImageSet : String(d.productImageSet || "").split(","))]
    .map((x) => String(x || "").trim()).filter((x) => /^https:\/\//.test(x)))].slice(0, 12);
  return { row: {
    supplier: "cj", sku: v.vid, pid, cjSku: v.variantSku, name: name.slice(0, 200), category: d.categoryName || "",
    priceExVat: gbp2(cost / 1.2), costGBP: cost, rrp: 0, weightKg: (Number(v.variantWeight || d.productWeight) || 0) / 1000,
    stock, moq: 1, barcode: v.barcode || "", material: "", images, image: images[0] || "",
    descriptionHtml: String(d.description || "").slice(0, 8000), description: "",
    dimensions: v.variantLength && v.variantWidth && v.variantHeight ? `${Math.round(v.variantLength / 10)} x ${Math.round(v.variantWidth / 10)} x ${Math.round(v.variantHeight / 10)} cm` : "",
    deliveryGBP: gbp2(ship.usd * fx * vat()), deliveryService: ship.name, deliveryDaysMax: ship.days,
  } };
}

// ---------- Importer ----------
/**
 * Works through CJ's UK-warehouse catalogue (popular first) and queues products that pass every rule.
 * Cheap checks first (rules, rough price vs eBay), then eBay demand, then CJ's exact price and delivery.
 * Progress is saved, so each run carries on where the last stopped. Returns a summary.
 */
export async function importFromCJ({ maxChecks = Number(env("CJ_MAX_CHECKS", "120")), budgetMs = 12 * 60e3 } = {}) {
  const started = Date.now();
  const st = (await getJSON("cj/state")) || { page: 1, idx: 0, totals: {} };
  const seen = (await getJSON("cj/seen")) || {};
  const run = { at: new Date().toISOString(), checked: 0, queued: [], skipped: {}, error: null };
  const skip = (pid, why) => { run.skipped[why] = (run.skipped[why] || 0) + 1; seen[pid] = { at: run.at, why }; };
  const fx = await usdToGbp();
  const bar = demandBar("cj");
  try {
    let pagesRead = 0;
    outer: while (run.checked < maxChecks && Date.now() - started < budgetMs && pagesRead < Number(env("CJ_PAGES_PER_RUN", "20"))) {
      const pg = await ukProducts(st.page); pagesRead++;
      if (!pg.ok) { run.error = "CJ catalogue: " + pg.error; break; }
      if (!pg.list.length) { st.page = 1; st.idx = 0; st.wrappedAt = run.at; break; }
      for (; st.idx < pg.list.length; st.idx++) {
        if (run.checked >= maxChecks || Date.now() - started > budgetMs) break outer;
        const p = pg.list[st.idx];
        const pid = p.id || p.pid;
        if (!pid) continue;
        if (seen[pid] && Date.now() - Date.parse(seen[pid].at) < 30 * 864e5) continue;
        const name = String(p.nameEn || p.productNameEn || "").trim();
        // 1. Rules on the name alone (regulated/electrical/children's etc.)
        const pre = exclusion({ supplier: "cj", name, priceExVat: 1, costGBP: 1, rrp: 0, moq: 1, stock: 99, weightKg: 0.5, category: "x > " + (p.threeCategoryName || "") });
        if (pre) { skip(pid, pre); continue; }
        run.checked++;
        // 2. Rough price check against the cheapest eBay rival (assumes £3.50 UK delivery)
        const roughCost = usd(p.nowPrice || p.discountPrice || p.sellPrice) * fx * vat();
        const m = await ebayMatch({ name });
        if (!m.checked) { run.error = "eBay price check failed: " + (m.reason || ""); break outer; }
        const rough = quote({ supplier: "cj", costGBP: roughCost, deliveryGBP: 3.5 * vat(), weightKg: 0.5 }, m.cheapest);
        if (!rough.ok) { skip(pid, "can't beat eBay price with £1.50 profit"); continue; }
        // 3. eBay demand
        const dm = await ebayDemand({ name });
        if (!dm.checked) { run.error = "eBay demand check: " + dm.reason; if (dm.rateLimited) break outer; continue; }
        if (dm.perMonth < bar) { skip(pid, `under ${bar} sales a month on eBay`); continue; }
        // 4. Exact CJ price + UK delivery for the best UK-stocked variant
        const { row, error } = await cjRow(pid, fx);
        if (!row) { skip(pid, error); continue; }
        const why = exclusion(row);
        if (why) { skip(pid, why); continue; }
        const q = quote(row, m.cheapest);
        if (!q.ok) { skip(pid, "exact cost too high: " + q.reasons.join("; ")); continue; }
        const k = queueKey(row);
        if (await getJSON(k)) { skip(pid, "already in queue"); continue; }
        await setJSON(k, { ...row, notes: notes(row), status: "queued", addedAt: run.at, demand: dm,
          screened: { at: run.at, cheapest: m.cheapest, count: m.count, searchUrl: m.searchUrl, top: (m.top || []).slice(0, 3), headroomPence: m.cheapest != null ? Math.round(m.cheapest * 100) - q.pricePence : null } });
        seen[pid] = { at: run.at, why: "queued" };
        run.queued.push({ name: row.name, pricePence: q.pricePence, profitPence: q.profitPence, perMonth: dm.perMonth });
      }
      st.page++; st.idx = 0;
      if (pg.totalPages && st.page > Math.min(pg.totalPages, Number(env("CJ_MAX_PAGES", "60")))) { st.page = 1; st.wrappedAt = run.at; break; }
    }
  } catch (e) { run.error = String(e.message || e); }
  for (const [k, v] of Object.entries(run.skipped)) st.totals[k] = (st.totals[k] || 0) + v;
  st.totals.queued = (st.totals.queued || 0) + run.queued.length;
  st.lastRun = { ...run, seconds: Math.round((Date.now() - started) / 1000) };
  // keep the seen-list from growing forever
  const keep = Object.entries(seen).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, 8000);
  await setJSON("cj/seen", Object.fromEntries(keep));
  await setJSON("cj/state", st);
  return st.lastRun;
}

export async function cjStatus() {
  const st = await getJSON("cj/state");
  const queued = (await listKeys("queue/cj-")).length;
  return { connected: !cjProblem(), state: st, inQueue: queued };
}
