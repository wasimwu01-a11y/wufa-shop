// One research cycle: decide if a proposal is due, research a candidate, check price + competition,
// save it and email it for approval.
import { LISTING_INTERVAL_DAYS, MIN_PROFIT_GBP, env } from "./config.mjs";
import { getJSON, setJSON, listKeys, getAll, newId } from "./store.mjs";
import { research, costUSD } from "./research.mjs";
import { ebayCompetition, ebayMatch, ebayDemand } from "./competitors.mjs";
import { SUPPLIERS, quote, feeRate, fixedFee } from "./catalog.mjs";
import { priceItem, gbp } from "./pricing.mjs";
import { sendEmail, proposalEmail, queueEmptyEmail } from "./email.mjs";
import { supplierBrief, recordChecks, getSupplier } from "./suppliers.mjs";

export const dailyBudget = () => parseFloat(env("AGENT_DAILY_BUDGET_USD", "3")) || 3;
const MAX_RUN_MS = 11 * 60e3; // background jobs stop at 15 minutes; leave room to save and email
const OPEN = ["awaiting_approval", "awaiting_registration", "price_failed", "running"];
const clamp = (x, lo, hi, d) => (Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : d);
const okUrl = (u) => /^https:\/\/[^\s]+$/i.test(String(u || ""));

/** Is a new proposal due? Returns { due, reason }. */
export async function proposalDue(now = Date.now()) {
  const meta = (await getJSON("meta/agent")) || {};
  if (meta.running && now - Date.parse(meta.running) < 30 * 60e3) return { due: false, reason: "a research run is already in progress" };
  for (const { k, v: p } of await getAll("proposal/")) {
    if (k.startsWith("proposal/TEST-")) continue;
    if (OPEN.includes(p.status)) return { due: false, reason: `proposal "${p.title}" is waiting for you (${p.status.replace(/_/g, " ")})` };
  }
  const today = new Date(now).toISOString().slice(0, 10);
  if (meta.spend?.date === today && meta.spend.usd >= dailyBudget())
    return { due: false, reason: `today's research budget ($${dailyBudget().toFixed(2)}) is used up; it carries on tomorrow` };
  if (meta.lastProposalAt && now - Date.parse(meta.lastProposalAt) < LISTING_INTERVAL_DAYS * 864e5 - 3600e3)
    return { due: false, reason: `last proposal was ${new Date(meta.lastProposalAt).toUTCString()}; next one after ${LISTING_INTERVAL_DAYS} days` };
  return { due: true, reason: "due" };
}

async function previousTitles() {
  const out = [];
  for (const { k, v: p } of await getAll("proposal/")) {
    if (k.startsWith("proposal/TEST-")) continue;
    if (p?.title) out.push(`${p.title} (${p.supplier?.name || "?"})`);
  }
  return out.slice(-40);
}

/** Check a researched candidate. Returns { ok, reasons, pricing, competition } */
export async function evaluate(c) {
  const reasons = [];
  if (!c?.found) return { ok: false, reasons: [c?.reasonNotFound || "nothing found"] };
  for (const f of ["title", "searchTerms", "supplierProductUrl"]) if (!c[f]) reasons.push("missing " + f);
  if (!okUrl(c.supplierProductUrl) || !okUrl(c.supplier?.url)) reasons.push("supplier links must be https");
  if (!(c.supplierCostGBP > 0 && c.supplierCostGBP < 500)) reasons.push("supplier cost missing or implausible");
  if (c.supplier?.payPerOrderByCard !== true || /top.?up|wallet|deposit|prepa(id|y)|minimum order/i.test(c.supplier?.payment || ""))
    reasons.push("supplier must take card payment per order (no wallet top-up, deposit or minimum order)");
  if (!(c.deliveryDaysMax > 0)) reasons.push("supplier's delivery time not stated");
  else if (c.deliveryDaysMax > 10) reasons.push(`delivery up to ${c.deliveryDaysMax} working days is longer than 10`);
  if (reasons.length) return { ok: false, reasons };

  const live = await ebayCompetition(c.searchTerms).catch(() => null);
  const competition = live || {
    source: "estimated (eBay keys not connected yet)",
    count: c.competitorCount ?? null,
    cheapestTotalGBP: c.cheapestCompetitorGBP ?? null,
  };

  // Supplier also sells this item on eBay: its own price is the real competition.
  const ownEbay = c.supplierSellsOnEbay && c.supplierEbayPriceGBP > 0 ? c.supplierEbayPriceGBP : null;
  if (ownEbay != null && (competition.cheapestTotalGBP == null || ownEbay < competition.cheapestTotalGBP)) {
    competition.cheapestTotalGBP = ownEbay;
    competition.source += "; supplier's own eBay listing";
  }
  const pricing = priceItem({
    supplierCost: c.supplierCostGBP,
    supplierDelivery: clamp(c.supplierDeliveryGBP, 0, 50, 0),
    feeRate: clamp(c.ebayFeeRate, 0.05, 0.2, 0.13),          // keep fee guesses within sane bounds
    fixedFee: clamp(c.ebayFixedFeeGBP, 0, 1, 0.4),
    minProfit: MIN_PROFIT_GBP,
    cheapestCompetitor: competition.cheapestTotalGBP,
  });
  if (ownEbay != null && pricing.pricePence > Math.round(ownEbay * 100))
    pricing.reasons = pricing.reasons.map((r) => r.replace("the cheapest competitor", "the supplier's own eBay price"));
  return { ok: pricing.ok, reasons: pricing.reasons, pricing, competition };
}

// ---------- Listing queue (products chosen in the screener) ----------
/** Proposes the best queued product that still beats eBay today. Returns a result, or null if the queue is empty. */
/** Minimum sales a month (across similar eBay UK listings) a product must show before it's proposed.
 *  Your original AW / Something Different queue uses a low bar; products from any new supplier must show real volume. */
export function demandBar(supplier) {
  const legacy = env("DEMAND_LEGACY_SUPPLIERS", "aw,sd").split(",").map((x) => x.trim());
  return legacy.includes(supplier) ? Number(env("DEMAND_MIN_PER_MONTH_EXISTING", "1")) : Number(env("DEMAND_MIN_PER_MONTH", "100"));
}

export async function proposeFromQueue(meta) {
  const items = [];
  for (const { k, v: q } of await getAll("queue/")) if (q.status === "queued") items.push({ k, q });
  if (!items.length) return null;
  const h = (q) => q.screened?.headroomPence ?? -1;  // products with no rivals found come after ones with proven headroom
  items.sort((a, b) => h(b.q) - h(a.q));
  const tried = [];
  // Products already measured below the bar are skipped without spending eBay look-ups.
  const fresh = (q) => q.demand?.at && Date.now() - Date.parse(q.demand.at) < 14 * 864e5;
  for (const { k, q } of items) if (fresh(q) && q.demand.perMonth < demandBar(q.supplier)) await setJSON(k, { ...q, status: "no_demand" });
  const live = items.filter(({ q }) => !(fresh(q) && q.demand.perMonth < demandBar(q.supplier)));
  for (const { k, q } of live.slice(0, 12)) {
    let d = fresh(q) ? q.demand : await ebayDemand({ name: q.name, barcode: q.barcode });
    if (!d.checked) return { sent: false, reason: "couldn't check eBay demand (" + (d.reason || "unknown") + ")" };
    if (!fresh(q)) await setJSON(k, { ...q, demand: d });
    if (d.perMonth < demandBar(q.supplier)) { await setJSON(k, { ...q, demand: d, status: "no_demand" }); tried.push(q.name + ": only ~" + d.perMonth + " sales a month on eBay (needs " + demandBar(q.supplier) + ")"); continue; }
    const m = await ebayMatch({ name: q.name, barcode: q.barcode });
    if (!m.checked) return { sent: false, reason: "couldn't re-check eBay prices (" + (m.reason || "unknown") + ")" };
    const pr = quote(q, m.cheapest);
    if (!pr.ok) { await setJSON(k, { ...q, status: "failed_recheck", recheck: { at: new Date().toISOString(), reasons: pr.reasons, cheapest: m.cheapest } }); tried.push(q.name + ": " + pr.reasons.join("; ")); continue; }
    const s = SUPPLIERS[q.supplier];
    const known = await getSupplier(s.url);
    const p = {
      id: newId("P"), status: "awaiting_approval", source: "catalog", queueKey: k, createdAt: new Date().toISOString(),
      title: String(q.name).slice(0, 80), searchTerms: q.name, category: q.category || "", sku: q.sku, image: q.image || "", description: q.description || "",
      supplierProductUrl: s.productUrl(q.sku, q),
      supplier: { name: s.name, url: s.url, registered: true, policyEvidence: s.policyEvidence, dispatch: s.dispatch, payment: s.payment, signupNotes: known?.discountNote || "" },
      supplierCostGBP: q.costGBP > 0 ? q.costGBP : Math.round(q.priceExVat * 1.2 * 100) / 100, supplierDeliveryGBP: pr.deliveryGBP, feeRate: feeRate(), fixedFee: fixedFee(),
      dispatchDays: s.dispatchDays, deliveryDaysMax: q.deliveryDaysMax || s.deliveryDaysMax, deliveryEvidence: "Supplier's published dispatch and delivery terms",
      costIsEstimate: false, costEvidence: q.supplier === "cj" ? `CJ UK-warehouse price £${q.costGBP.toFixed(2)} and ${q.deliveryService || "UK delivery"} £${pr.deliveryGBP.toFixed(2)} (converted from USD with a card-fee buffer, VAT included)` : `Supplier product file: £${q.priceExVat.toFixed(2)} ex VAT + 20% VAT; delivery £${pr.deliveryGBP.toFixed(2)} inc VAT for ${Math.round(q.weightKg * 1000)} g`,
      feeEvidence: `eBay ${(feeRate() * 100).toFixed(1)}% + £${fixedFee().toFixed(2)} per order (screening assumption)`,
      pricing: pr, estimateCostPence: pr.costPence, competitionSource: "eBay API",
      competition: `${m.count} comparable new UK Buy It Now listings; cheapest ${m.cheapest != null ? gbp(Math.round(m.cheapest * 100)) : "none found"} incl. postage`,
      demand: `~${d.perMonth} sales a month across ${d.listings} similar UK listings (${d.sold} sold in total)` + (d.top?.[0] ? `; best seller ${d.top[0].sold} sold, ~${d.top[0].perMonth}/month` : "") + ` – your bar for this supplier is ${demandBar(q.supplier)}/month`,
      risks: (q.notes || []).join("; "), sources: [m.searchUrl, ...(m.top || []).map((t) => t.url)].filter(okUrl).slice(0, 5),
      run: null, history: [{ at: new Date().toISOString(), note: "Proposed from listing queue" }],
    };
    await setJSON("proposal/" + p.id, p);
    await setJSON(k, { ...q, status: "proposed", proposalId: p.id });
    await sendEmail(proposalEmail(p));
    await setJSON("meta/agent", { ...meta, running: null, lastProposalAt: p.createdAt, lastRun: { at: p.createdAt, attempts: tried.map((t) => ({ title: t, ok: false, reasons: ["failed eBay re-check"] })).concat([{ title: p.title, ok: true, reasons: [] }]) } });
    return { sent: true, id: p.id, title: p.title, from: "queue" };
  }
  await setJSON("meta/agent", { ...meta, running: null, lastRun: { at: new Date().toISOString(), attempts: tried.map((t) => ({ title: t, ok: false, reasons: ["failed eBay re-check"] })) } });
  return { sent: false, reason: "no queued product passed the eBay price and demand checks (" + tried.length + " checked)" };
}

/** Internet (AI) research runs only if you allowed it by email, or AGENT_AI_RESEARCH=1 is set in Netlify. */
export async function researchAllowed() {
  if (env("AGENT_AI_RESEARCH") === "1") return true;
  return (await getJSON("agent/settings"))?.status === "research_on";
}

/** Emails you once when the queue runs dry (reminds weekly while it stays empty and you haven't chosen). */
export async function notifyQueueEmpty(detail = "") {
  const meta = (await getJSON("meta/agent")) || {};
  const last = meta.queueEmptyNotifiedAt ? Date.parse(meta.queueEmptyNotifiedAt) : 0;
  const reason = "the listing queue is empty – waiting for you to add products or allow internet research";
  if (Date.now() - last < 7 * 864e5) return { sent: false, reason };
  const settings = (await getJSON("agent/settings")) || {};
  await setJSON("agent/settings", { ...settings, status: "awaiting_choice", askedAt: new Date().toISOString(),
    history: [...(settings.history || []), { at: new Date().toISOString(), note: "Asked: queue empty" }] });
  let counts = {};
  for (const { v: q } of await getAll("queue/")) counts[q.status] = (counts[q.status] || 0) + 1;
  await sendEmail(queueEmptyEmail({ counts, detail }));
  await setJSON("meta/agent", { ...meta, running: null, queueEmptyNotifiedAt: new Date().toISOString() });
  return { sent: false, notified: true, reason };
}

/** Run one cycle: keep researching until a candidate passes, the run's time is up, or today's budget is spent.
 *  Returns { sent } or { sent:false, chain } – chain=true means "start another run, budget remains". */
export async function runCycle({ force = false } = {}) {
  const due = await proposalDue();
  if (!force && !due.due) return { sent: false, reason: due.reason };
  if (force && /in progress|waiting for you|budget/.test(due.reason)) return { sent: false, reason: due.reason };

  {
    const meta0 = (await getJSON("meta/agent")) || {};
    const fromQueue = await proposeFromQueue(meta0);
    if (fromQueue?.sent || /couldn't (re-)?check/.test(fromQueue?.reason || "")) return fromQueue;
    // Queue is empty (or nothing in it beats eBay any more).
    if (!(await researchAllowed())) return await notifyQueueEmpty(fromQueue?.reason);
    if (!env("ANTHROPIC_API_KEY")) return { sent: false, reason: "internet research is allowed but ANTHROPIC_API_KEY is not set" };
  }
  const started = Date.now();
  let meta = (await getJSON("meta/agent")) || {};
  await setJSON("meta/agent", { ...meta, running: new Date().toISOString() });
  const runLog = { at: new Date().toISOString(), attempts: [] };
  const totalUsage = { input: 0, output: 0, searches: 0, fetches: 0 };
  const today = new Date().toISOString().slice(0, 10);
  let spentToday = meta.spend?.date === today ? meta.spend.usd : 0;
  const maxAttempts = parseInt(env("AGENT_MAX_ATTEMPTS", "8"), 10) || 8;
  try {
    const prev = await previousTitles();
    const tried = [];
    for (let i = 0; i < maxAttempts; i++) {
      if (Date.now() - started > MAX_RUN_MS) break;
      if (spentToday >= dailyBudget()) break;
      const feedback = tried.length
        ? tried.slice(-6).join(" | ") + ". Try a different product" + (tried.length >= 3 ? ", a different supplier or a different category within pet/fitness" : "")
        : "";
      const { proposal: c, usage } = await research(prev, feedback, await supplierBrief());
      await recordChecks(c?.suppliersChecked).catch(() => {});
      for (const k in totalUsage) totalUsage[k] += usage[k] || 0;
      spentToday += costUSD(usage);
      meta = { ...meta, spend: { date: today, usd: Math.round(spentToday * 100) / 100 } };
      await setJSON("meta/agent", { ...meta, running: new Date(started).toISOString() });
      const ev = await evaluate(c);
      runLog.attempts.push({ title: c?.title || null, ok: ev.ok, reasons: ev.reasons });
      if (!ev.ok) {
        tried.push(c?.found === false ? `nothing found (${String(c?.reasonNotFound || "").slice(0, 200)})` : `"${c?.title}" from ${c?.supplier?.name} failed: ${ev.reasons.join("; ")}`);
        if (c?.title) prev.push(`${c.title} (${c?.supplier?.name})`);
        continue;
      }
      const cost = costUSD(totalUsage);
      const p = {
        id: newId("P"),
        status: "awaiting_approval",
        createdAt: new Date().toISOString(),
        title: String(c.title).slice(0, 80),
        searchTerms: c.searchTerms,
        category: c.category || "",
        supplierProductUrl: c.supplierProductUrl,
        supplier: { ...c.supplier, registered: !!(await getSupplier(c.supplier.url))?.registered },
        supplierCostGBP: c.supplierCostGBP,
        supplierDeliveryGBP: c.supplierDeliveryGBP || 0,
        feeRate: clamp(c.ebayFeeRate, 0.05, 0.2, 0.13),
        fixedFee: clamp(c.ebayFixedFeeGBP, 0, 1, 0.4),
        dispatchDays: c.dispatchDays ?? null,
        deliveryDaysMax: c.deliveryDaysMax,
        deliveryEvidence: c.deliveryEvidence || "",
        costIsEstimate: !!c.costIsEstimate,
        costEvidence: c.costEvidence || "",
        feeEvidence: c.feeEvidence || "",
        pricing: ev.pricing,
        estimateCostPence: ev.pricing.costPence,
        competitionSource: ev.competition.source,
        competition: `${ev.competition.count ?? "?"} listings, cheapest ${ev.competition.cheapestTotalGBP != null ? gbp(Math.round(ev.competition.cheapestTotalGBP * 100)) : "unknown"} incl. postage – ${ev.competition.source}${c.competitionNotes ? ". " + c.competitionNotes : ""}`,
        demand: c.demandEvidence || "",
        risks: c.risks || "",
        sources: (c.sources || []).filter(okUrl).slice(0, 12),
        run: { usage: totalUsage, costUSD: Math.round(cost * 100) / 100 },
        history: [{ at: new Date().toISOString(), note: "Proposed" }],
      };
      await setJSON("proposal/" + p.id, p);
      await sendEmail(proposalEmail(p));
      await setJSON("meta/agent", { ...meta, running: null, lastProposalAt: p.createdAt, lastRun: runLog });
      return { sent: true, id: p.id, title: p.title, cost: p.run.costUSD };
    }
    await setJSON("meta/agent", { ...meta, running: null, lastRun: runLog, lastEmptyRunAt: new Date().toISOString() });
    const chain = spentToday < dailyBudget() - 0.25 && (meta.chainCount?.date !== today || meta.chainCount.n < 20);
    if (chain) await setJSON("meta/agent", { ...meta, running: null, lastRun: runLog, lastEmptyRunAt: new Date().toISOString(),
      chainCount: { date: today, n: (meta.chainCount?.date === today ? meta.chainCount.n : 0) + 1 } });
    return { sent: false, chain, reason: "no candidate passed the checks yet", attempts: runLog.attempts, spentToday: Math.round(spentToday * 100) / 100 };
  } catch (e) {
    await setJSON("meta/agent", { ...meta, running: null, lastRun: { ...runLog, error: String(e.message || e) } });
    throw e;
  }
}
