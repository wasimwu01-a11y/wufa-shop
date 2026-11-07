// One research cycle: decide if a proposal is due, research a candidate, check price + competition,
// save it and email it for approval.
import { LISTING_INTERVAL_DAYS, MIN_PROFIT_GBP, env } from "./config.mjs";
import { getJSON, setJSON, listKeys, newId } from "./store.mjs";
import { research, costUSD } from "./research.mjs";
import { ebayCompetition } from "./competitors.mjs";
import { priceItem, gbp } from "./pricing.mjs";
import { sendEmail, proposalEmail } from "./email.mjs";

const OPEN = ["awaiting_approval", "awaiting_registration", "price_failed", "running"];
const clamp = (x, lo, hi, d) => (Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : d);
const okUrl = (u) => /^https:\/\/[^\s]+$/i.test(String(u || ""));

/** Is a new proposal due? Returns { due, reason }. */
export async function proposalDue(now = Date.now()) {
  const meta = (await getJSON("meta/agent")) || {};
  if (meta.running && now - Date.parse(meta.running) < 30 * 60e3) return { due: false, reason: "a research run is already in progress" };
  for (const k of await listKeys("proposal/")) {
    if (k.startsWith("proposal/TEST-")) continue;
    const p = await getJSON(k);
    if (p && OPEN.includes(p.status)) return { due: false, reason: `proposal "${p.title}" is waiting for you (${p.status.replace(/_/g, " ")})` };
  }
  if (meta.lastProposalAt && now - Date.parse(meta.lastProposalAt) < LISTING_INTERVAL_DAYS * 864e5 - 3600e3)
    return { due: false, reason: `last proposal was ${new Date(meta.lastProposalAt).toUTCString()}; next one after ${LISTING_INTERVAL_DAYS} days` };
  return { due: true, reason: "due" };
}

async function previousTitles() {
  const out = [];
  for (const k of await listKeys("proposal/")) {
    if (k.startsWith("proposal/TEST-")) continue;
    const p = await getJSON(k);
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
  if (reasons.length) return { ok: false, reasons };

  const live = await ebayCompetition(c.searchTerms).catch(() => null);
  const competition = live || {
    source: "estimated (eBay keys not connected yet)",
    count: c.competitorCount ?? null,
    cheapestTotalGBP: c.cheapestCompetitorGBP ?? null,
  };

  const pricing = priceItem({
    supplierCost: c.supplierCostGBP,
    supplierDelivery: clamp(c.supplierDeliveryGBP, 0, 50, 0),
    feeRate: clamp(c.ebayFeeRate, 0.05, 0.2, 0.13),          // keep fee guesses within sane bounds
    fixedFee: clamp(c.ebayFixedFeeGBP, 0, 1, 0.4),
    minProfit: MIN_PROFIT_GBP,
    cheapestCompetitor: competition.cheapestTotalGBP,
  });
  return { ok: pricing.ok, reasons: pricing.reasons, pricing, competition };
}

/** Run one cycle. force=true skips the "is it due" check (manual trigger). */
export async function runCycle({ force = false } = {}) {
  const due = await proposalDue();
  if (!force && !due.due) return { sent: false, reason: due.reason };
  if (force && /in progress|waiting for you/.test(due.reason)) return { sent: false, reason: due.reason };

  const meta = (await getJSON("meta/agent")) || {};
  await setJSON("meta/agent", { ...meta, running: new Date().toISOString() });
  const runLog = { at: new Date().toISOString(), attempts: [] };
  const totalUsage = { input: 0, output: 0, searches: 0, fetches: 0 };
  try {
    const prev = await previousTitles();
    let feedback = "";
    const attempts = parseInt(env("AGENT_ATTEMPTS", "2"), 10) || 2;
    for (let i = 0; i < attempts; i++) {
      const { proposal: c, usage } = await research(prev, feedback);
      for (const k in totalUsage) totalUsage[k] += usage[k] || 0;
      const ev = await evaluate(c);
      runLog.attempts.push({ title: c?.title || null, ok: ev.ok, reasons: ev.reasons });
      if (!ev.ok) {
        if (c?.found === false) break; // researcher found nothing at all; don't spend more this run
        feedback = `"${c?.title}" from ${c?.supplier?.name}: ${ev.reasons.join("; ")}`;
        prev.push(`${c?.title} (${c?.supplier?.name})`);
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
        supplier: { ...c.supplier, registered: false },
        supplierCostGBP: c.supplierCostGBP,
        supplierDeliveryGBP: c.supplierDeliveryGBP || 0,
        feeRate: clamp(c.ebayFeeRate, 0.05, 0.2, 0.13),
        fixedFee: clamp(c.ebayFixedFeeGBP, 0, 1, 0.4),
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
    return { sent: false, reason: "no candidate passed the checks", attempts: runLog.attempts, costUSD: Math.round(costUSD(totalUsage) * 100) / 100 };
  } catch (e) {
    await setJSON("meta/agent", { ...meta, running: null, lastRun: { ...runLog, error: String(e.message || e) } });
    throw e;
  }
}
