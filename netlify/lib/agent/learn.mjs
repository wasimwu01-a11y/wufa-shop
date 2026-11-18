// The agent's learning loop (runs weekly in the background):
//  1. Collect: eBay traffic per agent listing (impressions, views, click-through, conversion), your orders,
//     the cheapest rival price, and fresh demand for the top of the queue (to see what's rising or falling).
//  2. Learn: which suppliers, supplier categories, price bands, photo counts and promotion get seen, clicked
//     and bought – with smoothing so a handful of clicks can't swing it – and turn that into ranking weights.
//  3. Act: improve titles/descriptions (Claude), end listings that clearly don't work, and re-rank the queue.
//  4. Report: one weekly email with what it learned, what it changed, and an Undo button per change.
import { env } from "./config.mjs";
import { getJSON, setJSON, getAll, update, newId } from "./store.mjs";
import { sell, ebayErrors, sellerStatus } from "./ebayuser.mjs";
import { ebayMatch, ebayDemand } from "./competitors.mjs";
import { betterTitle, betterDescription, rivalTitles } from "./writer.mjs";
import { blocks as descBlocks } from "./describe.mjs";
import { startListing } from "./trigger.mjs";

const DAY = 864e5;
const n = (x) => (Number.isFinite(+x) ? +x : 0);
const MIN_AGE = () => Number(env("AGENT_LEARN_MIN_AGE_DAYS", "14"));
const END_AGE = () => Number(env("AGENT_LEARN_END_AGE_DAYS", "45"));
const MAX_ACTIONS = () => Number(env("AGENT_LEARN_MAX_CHANGES", "6"));
const autoChanges = () => env("AGENT_LEARN_AUTO", "1") !== "0";

// ---------- 1. Collect ----------
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
const rate = (v) => { const x = n(v); return x > 1 ? x / 100 : x; }; // eBay may report rates as % or as a fraction

/** eBay Analytics traffic report for up to 200 listings over the last `days` days. */
export async function trafficReport(listingIds, days = 30) {
  if (!listingIds.length) return {};
  const filter = `marketplace_ids:{EBAY_GB},date_range:[${ymd(Date.now() - days * DAY)}..${ymd(Date.now() - DAY)}],listing_ids:{${listingIds.slice(0, 200).join("|")}}`;
  const metrics = ["LISTING_IMPRESSION_TOTAL", "LISTING_VIEWS_TOTAL", "CLICK_THROUGH_RATE", "SALES_CONVERSION_RATE", "TRANSACTION"];
  const r = await sell("GET", "/sell/analytics/v1/traffic_report?" + new URLSearchParams({ dimension: "LISTING", metric: metrics.join(","), filter }));
  if (!r.ok) throw new Error("eBay traffic report: " + ebayErrors(r));
  const keys = (r.body.header?.metrics || []).map((m) => m.key);
  const out = {};
  for (const rec of r.body.records || []) {
    const id = String(rec.dimensionValues?.[0]?.value || "");
    const v = Object.fromEntries(keys.map((k, i) => [k, rec.metricValues?.[i]?.value]));
    out[id] = { impressions: n(v.LISTING_IMPRESSION_TOTAL), views: n(v.LISTING_VIEWS_TOTAL), ctr: rate(v.CLICK_THROUGH_RATE), conversion: rate(v.SALES_CONVERSION_RATE), transactions: n(v.TRANSACTION) };
  }
  return out;
}

/** Units sold and revenue per eBay listing over the last `days` days (your orders). */
export async function salesByListing(days = 90) {
  const out = {};
  let url = "/sell/fulfillment/v1/order?" + new URLSearchParams({ filter: `creationdate:[${new Date(Date.now() - days * DAY).toISOString()}..]`, limit: "200" });
  for (let page = 0; url && page < 10; page++) {
    const r = await sell("GET", url);
    if (!r.ok) throw new Error("eBay orders: " + ebayErrors(r));
    for (const o of r.body.orders || []) {
      if (o.cancelStatus?.cancelState === "CANCELED") continue;
      for (const li of o.lineItems || []) {
        const id = String(li.legacyItemId || ""); if (!id) continue;
        const s = (out[id] ||= { units: 0, revenuePence: 0, orders: 0, lastSaleAt: null });
        s.units += n(li.quantity) || 1; s.orders++; s.revenuePence += Math.round(n(li.total?.value || li.lineItemCost?.value) * 100);
        if (!s.lastSaleAt || o.creationDate > s.lastSaleAt) s.lastSaleAt = o.creationDate;
      }
    }
    url = r.body.next ? r.body.next.replace(/^https?:\/\/[^/]+/, "") : null;
  }
  return out;
}

// ---------- 2. Learn ----------
const priceBand = (p) => (p < 1000 ? "under £10" : p < 2000 ? "£10–20" : p < 4000 ? "£20–40" : "£40+");
const photoBand = (k) => (k >= 7 ? "7+ photos" : k >= 4 ? "4–6 photos" : "1–3 photos");
const leaf = (c) => String(c || "").split(">").pop().trim() || "uncategorised";
export function features(x) {
  return [
    "supplier:" + (x.supplier || "?"),
    "category:" + leaf(x.supplierCategory ?? x.category),
    "price:" + priceBand(n(x.pricePence)),
    "photos:" + photoBand(n(x.photos ?? (x.images || []).length)),
    ...(x.promoted != null ? ["promoted:" + (x.promoted ? "yes" : "no")] : []),
  ];
}

/**
 * Builds smoothed stats per feature from listing snapshots: CTR = (clicks + 500·prior)/(impressions + 500),
 * conversion = (sales + 50·prior)/(clicks + 50). Score = CTR×conversion relative to the shop average, clamped 0.5–2.
 */
export function buildModel(rows) {
  const tot = rows.reduce((a, r) => ({ imp: a.imp + r.impressions, clicks: a.clicks + r.clicks, sales: a.sales + r.sales }), { imp: 0, clicks: 0, sales: 0 });
  const pCtr = tot.imp >= 2000 ? tot.clicks / tot.imp : 0.015;             // eBay-typical defaults until there's data
  const pConv = tot.clicks >= 200 ? Math.max(tot.sales, 0.5) / tot.clicks : 0.02;
  const b = {};
  for (const r of rows) for (const f of r.features) { const x = (b[f] ||= { imp: 0, clicks: 0, sales: 0, listings: 0 }); x.imp += r.impressions; x.clicks += r.clicks; x.sales += r.sales; x.listings++; }
  const base = pCtr * pConv;
  const stats = {};
  for (const [f, x] of Object.entries(b)) {
    const ctr = (x.clicks + 500 * pCtr) / (x.imp + 500), conv = (x.sales + 50 * pConv) / (x.clicks + 50);
    stats[f] = { ...x, ctr, conv, weight: Math.min(2, Math.max(0.5, (ctr * conv) / base)), confident: x.imp >= 1000 || x.sales >= 2 };
  }
  return { at: new Date().toISOString(), totals: tot, priorCtr: pCtr, priorConv: pConv, stats };
}

/** Ranking weight for a queue item from what the shop has learned (1 = no evidence either way). */
export function learnedWeight(q, model) {
  if (!model?.stats) return 1;
  const fs = features({ supplier: q.supplier, category: q.category, pricePence: q.screened?.pricePence || 0, images: q.images || (q.image ? [q.image] : []) })
    .filter((f) => !f.startsWith("price:") || q.screened?.pricePence);
  let w = 1;
  for (const f of fs) { const s = model.stats[f]; if (s?.confident) w *= s.weight; }
  return Math.min(3, Math.max(0.33, w));
}

/** Demand trend from the product's sales-per-month history: >1 rising, <1 falling (0.7–1.5). */
export function trendFactor(q) {
  const h = (q.demandHistory || []).filter((x) => x.perMonth != null);
  if (h.length < 2) return 1;
  const a = h[h.length - 2].perMonth, b = h[h.length - 1].perMonth;
  if (a <= 0) return b > 0 ? 1.3 : 1;
  return Math.min(1.5, Math.max(0.7, b / a));
}

/** Plain-language summary of the strongest lessons (used in emails, Claude prompts and research). */
export function insightsText(model) {
  const s = Object.entries(model?.stats || {}).filter(([, x]) => x.confident).sort((a, b) => b[1].weight - a[1].weight);
  if (!s.length) return "";
  const fmt = ([f, x]) => `${f.replace(":", " ")} (${(x.ctr * 100).toFixed(1)}% click-through, ${x.sales} sold from ${x.listings} listings)`;
  const good = s.filter(([, x]) => x.weight > 1.15).slice(0, 3).map(fmt), bad = s.filter(([, x]) => x.weight < 0.85).slice(-3).map(fmt);
  return [good.length ? "Works best: " + good.join("; ") + "." : "", bad.length ? "Works worst: " + bad.join("; ") + "." : ""].filter(Boolean).join(" ");
}

// ---------- 3. Act ----------
async function recordChange(c) {
  const id = newId("CH");
  const rec = { id, status: "applied", at: new Date().toISOString(), ...c, history: [{ at: new Date().toISOString(), note: "Applied: " + c.reason }] };
  await setJSON("change/" + id, rec);
  return rec;
}

/** Re-sends a live listing with a new title and/or description (same category). */
async function revise(L, p, patch, note) {
  await update("proposal/" + p.id, { ...patch, lockedCategory: { id: L.categoryId, name: L.categoryName || "" }, status: "ready_to_list", revise: true, reviseQuiet: true }, note);
}

/** Ends (withdraws) a listing that isn't working. */
export async function endListing(k, L, reason) {
  const r = await sell("POST", `/sell/inventory/v1/offer/${L.offerId}/withdraw`);
  if (!r.ok && r.status !== 404) throw new Error("eBay wouldn't end the listing: " + ebayErrors(r));
  await setJSON(k, { ...L, ended: true, endedAt: new Date().toISOString(), endReason: reason, promo: L.promo ? { ...L.promo, status: "ended" } : L.promo });
  if (L.proposalId) await update("proposal/" + L.proposalId, { status: "ended" }, "Ended by the agent: " + reason);
  if (L.queueKey) await update(L.queueKey, { status: "ended_no_sales" }, "Ended: " + reason);
}

/** Decides what to do with one listing. Returns { action, reason } or null. */
export function decide(L, now = Date.now()) {
  const age = (now - Date.parse(L.listedAt)) / DAY;
  const p = L.perf || {}; const sales = n(L.sales?.units);
  if (L.ended || age < MIN_AGE()) return null;
  if (sales > 0) return null; // selling – leave it alone
  const impPerDay = p.impressions / Math.max(1, Math.min(age, 30));
  const lastTitle = L.learn?.titleAt ? (now - Date.parse(L.learn.titleAt)) / DAY : Infinity;
  const lastDesc = L.learn?.descAt ? (now - Date.parse(L.learn.descAt)) / DAY : Infinity;
  const undercut = L.market?.cheapest != null && L.market.cheapest * 100 < L.pricePence * 0.9;
  if (!L.noAutoEnd && age >= END_AGE() && (L.learn?.titleAt || undercut) && lastTitle >= 14)
    return { action: "end", reason: `no sales in ${Math.round(age)} days${undercut ? ` and rivals now sell for £${L.market.cheapest.toFixed(2)}, under our minimum price` : " even after a new title"}` };
  if (!L.noAutoTitle && lastTitle >= 21 && (impPerDay < 10 || (p.impressions >= 300 && p.ctr < 0.008)))
    return { action: "title", reason: impPerDay < 10 ? `only ~${impPerDay.toFixed(0)} search appearances a day – needs words buyers search for` : `seen ${p.impressions} times but only ${(p.ctr * 100).toFixed(1)}% click – title isn't pulling buyers in` };
  if (!L.noAutoDesc && lastDesc >= 30 && p.views >= 30)
    return { action: "description", reason: `${p.views} views but no sale – description needs to sell it better` };
  return null;
}

// ---------- The weekly run ----------
export async function learnRun({ force = false } = {}) {
  const meta = (await getJSON("agent/learn")) || {};
  if (!force && meta.lastRunAt && Date.now() - Date.parse(meta.lastRunAt) < 6.5 * DAY) return { skipped: "ran " + meta.lastRunAt };
  const st = await sellerStatus().catch(() => ({}));
  const run = { at: new Date().toISOString(), notes: [], changes: [], errors: [] };
  const listings = (await getAll("listing/")).filter(({ v }) => v.dropship && !v.ended);

  // 1. Collect
  let traffic = {}, sales = {};
  if (st.canAnalyse) { try { traffic = await trafficReport(listings.map(({ v }) => v.listingId)); } catch (e) { run.errors.push(String(e.message || e)); } }
  else run.notes.push("eBay traffic data needs one reconnect (adds the analytics permission).");
  try { sales = await salesByListing(); } catch (e) { run.errors.push(String(e.message || e)); }
  for (const { k, v: L } of listings) {
    const perf = traffic[L.listingId] || L.perf || { impressions: 0, views: 0, ctr: 0, conversion: 0 };
    const m = await ebayMatch({ name: L.title || "" }).catch(() => ({ checked: false }));
    const snap = { at: run.at, ...perf, units: sales[L.listingId]?.units || 0, cheapest: m.checked ? m.cheapest : null };
    await setJSON(k, { ...L, perf, sales: sales[L.listingId] || { units: 0 }, market: m.checked ? { cheapest: m.cheapest, count: m.count, at: run.at } : L.market, snapshots: [...(L.snapshots || []), snap].slice(-26) });
  }
  // fresh demand for the top of the queue → trends
  const queue = (await getAll("queue/")).filter(({ v }) => v.status === "queued").sort((a, b) => (b.v.screened?.headroomPence ?? -1) - (a.v.screened?.headroomPence ?? -1)).slice(0, Number(env("AGENT_LEARN_DEMAND_CHECKS", "15")));
  for (const { k, v: q } of queue) {
    const d = await ebayDemand({ name: q.name, barcode: q.barcode }).catch(() => ({ checked: false }));
    if (d.rateLimited) { run.notes.push("eBay's daily look-up limit reached during demand checks."); break; }
    if (d.checked) await setJSON(k, { ...q, demand: d, demandHistory: [...(q.demandHistory || []), { at: run.at, perMonth: d.perMonth }].slice(-12) });
  }

  // 2. Learn (all agent listings incl. ended ones – failures teach too)
  const all = (await getAll("listing/")).filter(({ v }) => v.dropship);
  const rows = all.filter(({ v }) => Date.now() - Date.parse(v.listedAt) >= 7 * DAY).map(({ v }) => {
    const imp = n(v.perf?.impressions);
    return { impressions: imp, clicks: imp * n(v.perf?.ctr), sales: n(v.sales?.units), features: features({ ...v, promoted: v.promo?.status === "on" || v.promo?.status === "ended" }) };
  });
  const model = buildModel(rows);
  const insights = insightsText(model);

  // 3. Act
  if (autoChanges()) {
    const fresh = (await getAll("listing/")).filter(({ v }) => v.dropship && !v.ended);
    for (const { k, v: L } of fresh) {
      if (run.changes.length >= MAX_ACTIONS()) break;
      const d = decide(L);
      if (!d) continue;
      const p = L.proposalId ? await getJSON("proposal/" + L.proposalId) : null;
      const q = L.queueKey ? await getJSON(L.queueKey) : null;
      if (!p || !q) continue;
      try {
        if (d.action === "end") {
          await endListing(k, L, d.reason);
          run.changes.push(await recordChange({ type: "end", listingId: L.listingId, proposalId: p.id, title: L.title, reason: d.reason }));
        } else if (d.action === "title") {
          const rivals = await rivalTitles(q.name);
          const t = await betterTitle({ current: L.title || p.listingTitle || p.title, supplierName: q.name, facts: [q.material, q.dimensions, q.description?.slice(0, 600)].filter(Boolean).join(". "), rivals, insights });
          if (!t.title || t.title === L.title) continue;
          await revise(L, p, { listingTitle: t.title }, "Agent improved the title: " + d.reason);
          await setJSON(k, { ...(await getJSON(k)), learn: { ...(L.learn || {}), titleAt: run.at } });
          run.changes.push(await recordChange({ type: "title", listingId: L.listingId, proposalId: p.id, before: L.title || p.listingTitle || p.title, after: t.title, by: t.by, reason: d.reason }));
        } else if (d.action === "description") {
          const nd = await betterDescription({ title: L.title || p.title, supplierText: descBlocks(q.descriptionHtml || q.description).map((b) => b.p || (b.ul || []).join(". ")).join("\n"), facts: [q.material, q.dimensions].filter(Boolean).join(". ") });
          if (!nd) { run.notes.push(`Couldn't write a better description for "${L.title}" this week (AI unavailable or result rejected).`); continue; }
          await revise(L, p, { aiDescription: nd }, "Agent improved the description: " + d.reason);
          await setJSON(k, { ...(await getJSON(k)), learn: { ...(L.learn || {}), descAt: run.at } });
          run.changes.push(await recordChange({ type: "description", listingId: L.listingId, proposalId: p.id, title: L.title, before: p.aiDescription || null, after: nd, by: nd.by, reason: d.reason }));
        }
      } catch (e) { run.errors.push(`${L.title}: ${e.message || e}`); }
    }
    if (run.changes.some((c) => c.type !== "end")) await startListing().catch(() => {});
  }

  await setJSON("agent/learn", { lastRunAt: run.at, model, insights, lastRun: { ...run, changes: run.changes.map((c) => ({ id: c.id, type: c.type, title: c.title || c.after, reason: c.reason })) } });
  return { run, model, insights, listings: (await getAll("listing/")).filter(({ v }) => v.dropship).map(({ v }) => v) };
}

/** Undo one change made by the learning loop. */
export async function undoChange(ch) {
  const p = await getJSON("proposal/" + ch.proposalId);
  if (!p) throw new Error("The listing's record no longer exists.");
  const lk = "listing/" + ch.listingId, L = (await getJSON(lk)) || {};
  if (ch.type === "title") {
    await update("proposal/" + p.id, { listingTitle: ch.before, lockedCategory: { id: L.categoryId, name: L.categoryName || "" }, status: "ready_to_list", revise: true, reviseQuiet: false }, "You undid the agent's title change");
    await setJSON(lk, { ...L, noAutoTitle: true });
  } else if (ch.type === "description") {
    await update("proposal/" + p.id, { aiDescription: ch.before, lockedCategory: { id: L.categoryId, name: L.categoryName || "" }, status: "ready_to_list", revise: true, reviseQuiet: false }, "You undid the agent's description change");
    await setJSON(lk, { ...L, noAutoDesc: true });
  } else if (ch.type === "end") {
    await update("proposal/" + p.id, { status: "ready_to_list", revise: false, lockedCategory: { id: L.categoryId, name: L.categoryName || "" } }, "You asked to relist it");
    await setJSON(lk, { ...L, noAutoEnd: true });
  }
  await startListing().catch(() => {});
}
