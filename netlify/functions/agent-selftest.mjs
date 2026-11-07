// /agent/selftest?key=<AGENT_SECRET>  – sends a sample proposal and a sample order pack (clearly marked TEST)
// so you can see the emails and try the buttons. Nothing is listed, bought or charged.
import { timingSafeEqual } from "node:crypto";
import { env } from "../lib/agent/config.mjs";
import { setJSON, newId } from "../lib/agent/store.mjs";
import { priceItem } from "../lib/agent/pricing.mjs";
import { sendEmail, proposalEmail, orderPackEmail } from "../lib/agent/email.mjs";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export default async (req) => {
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!env("AGENT_SECRET") || !same(key, env("AGENT_SECRET"))) return new Response("Not found", { status: 404 });

  const pricing = priceItem({ supplierCost: 6.0, supplierDelivery: 3.2, feeRate: 0.128, fixedFee: 0.3, cheapestCompetitor: 13.99 });
  const proposal = {
    id: newId("TEST"),
    status: "awaiting_approval",
    title: "TEST – Example product (not real)",
    searchTerms: "example product",
    supplierProductUrl: "https://example.com/product",
    supplier: { name: "Example Wholesale (TEST)", url: "https://example.com", signupUrl: "https://example.com/trade", registered: false,
      policyEvidence: "TEST: trade dropship programme, ships direct to customer from UK warehouse", dispatch: "TEST: 1–2 working days, tracked" },
    costIsEstimate: true,
    pricing,
    competition: "TEST: 14 listings, cheapest £13.99",
    demand: "TEST: sample text",
  };
  await setJSON("proposal/" + proposal.id, proposal);

  const order = {
    id: newId("TEST"),
    status: "awaiting_payment",
    channel: "website",
    channelOrderId: "TEST-0001",
    title: "TEST – Example product (not real)",
    quantity: 1,
    supplierName: "Example Wholesale (TEST)",
    supplierUrl: "https://example.com",
    supplierProductUrl: "https://example.com/product",
    shipTo: { name: "Test Customer", line1: "1 Example Street", city: "Belfast", postcode: "BT1 1AA", country: "GB", phone: "" },
    paidPence: pricing.pricePence,
    expectedCostPence: pricing.costPence,
    expectedProfitPence: pricing.profitPence,
    dispatchBy: "TEST – no deadline",
  };
  await setJSON("order/" + order.id, order);

  await sendEmail(proposalEmail(proposal));
  await sendEmail(orderPackEmail(order));
  return new Response("Sent two TEST emails to the agent inbox.", { headers: { "Content-Type": "text/plain" } });
};

export const config = { path: "/agent/selftest" };
