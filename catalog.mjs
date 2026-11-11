// Supplier catalogues (product files from Something Different and AW Dropship):
// which products are allowed, what they really cost Wufa, and what they must sell for.
import { priceItem } from "./pricing.mjs";
import { env } from "./config.mjs";

// eBay fees used for screening (override in Netlify if eBay changes them).
export const feeRate = () => parseFloat(env("EBAY_FEE_RATE", "0.128")) || 0.128;
export const fixedFee = () => parseFloat(env("EBAY_FIXED_FEE", "0.40")) || 0.4;

// Supplier terms. Wufa is not VAT-registered, so VAT on goods and delivery is a real cost.
export const SUPPLIERS = {
  sd: {
    name: "Something Different Wholesale",
    url: "https://www.somethingdifferentconnect.co.uk",
    productUrl: (sku) => "https://www.somethingdifferentconnect.co.uk/catalogsearch/result/?q=" + encodeURIComponent(sku),
    // Delivery is charged once per order on total weight, prices shown INCLUDING VAT (UK mainland).
    delivery: (kg) => (kg < 0.99 ? 4.79 : 5.99),
    dispatchDays: 1, deliveryDaysMax: 4,
    dispatch: "Swansea; same-day dispatch before 2pm; 48-hour tracked; unbranded box and packing slip",
    payment: "Card charged per order (pay-as-you-go), no deposit",
    policyEvidence: "Wholesale giftware supplier with a dedicated dropship programme (Something Different Connect) shipping direct to the buyer from its UK warehouse",
  },
  aw: {
    name: "AW Dropship (Ancient Wisdom)",
    url: "https://www.aw-dropship.com",
    productUrl: (sku) => "https://www.aw-dropship.com/search?q=" + encodeURIComponent(sku),
    // Delivery bands as published, EXCLUDING VAT (AW: "all our prices exclude tax") → +20%.
    delivery: (kg) => Math.round((kg < 0.1 ? 2.79 : kg <= 2 ? 2.99 : 5.99) * 1.2 * 100) / 100,
    dispatchDays: 2, deliveryDaysMax: 7,
    dispatch: "Sheffield; dispatch in 1–2 working days (3–4 in Oct–Dec); Royal Mail Tracked 48 up to 2 kg",
    payment: "Card paid per order at checkout, no deposit required",
    policyEvidence: "Wholesale giftware importer with a dedicated dropship platform shipping direct to the buyer from its UK warehouse",
  },
};

// Not allowed: regulated, age-restricted, children's, electrical, consumable or brand-risk goods.
const BAN = /\b(toy|toys|squish\w*|kids?|child\w*|baby|babies|nursery|teddy|plush|slime|fidget|lip|balm|soap|bath|bombs?|lotion|cream|skin|cosmetic\w*|perfume|fragrance|oils?|wax|melts?|snap discs?|reed|diffusers?|essential|incense|cones?|sticks?|sage|smudge|resin|candles?|tealights?|lighter|matches|knife|knives|blade|athame|sword|dagger|batter(y|ies)|led|lamps?|light|lights|bulb|usb|plug|electric|mains|charger|speaker|bluetooth|adaptors?|remote control|plants?|seeds?|sweets?|chocolate|candy|tea|food|edible|treats?|drinks?|alcohol|gin|wine|vape|cbd|salt shot|cooking|harry potter|disney|marvel|pokemon|star wars|licensed|official|halloween|pumpkin|skeleton|ghost|massage|shampoo|deodorant|hair)\b|by amy brown|by anne stokes/i;
const DISPLAY = /(\bset of \d{2,}|\bbox of \d{2,}|in (a )?display|on display|display (box|stand)|\b\d{2,} .*in a bag|wholesale|pack of \d{2,})/i;
const AW_DEPTS = new Set(["Home & Garden", "Crystals & Esoterics", "Jewellery", "Bags & Accessories", "Clothing", "Musical Instruments", "Pet Accessories", "Incense and Burners", "Candles & Holders"]);
const HEAL = /(crystal|chakra|healing|wellness|reiki|gemstone)/i;
const XMAS = /(christmas|advent|santa|gonk|reindeer|festive|xmas|snowflake|bauble)/i;

/** Returns a reason string if the product is not allowed, else "". `it` is a normalised catalogue row. */
export function exclusion(it) {
  if (!SUPPLIERS[it.supplier]) return "unknown supplier";
  if (it.discontinued) return "discontinued";
  if (!(it.priceExVat > 0) || !(it.rrp > 0)) return "no price";
  if ((it.moq || 1) !== 1) return "sold in multiples";
  if (!(it.stock >= 5)) return "low stock";
  if (!(it.weightKg > 0) || it.weightKg > 2) return "over 2 kg or no weight";
  if (it.supplier === "aw") {
    if (it.status && it.status !== "Active") return "not active";
    if (it.forSale && it.forSale !== "Yes") return "not for sale";
    if (["OutofStock", "Discontinuing", "VeryLow"].includes(it.stockFlag)) return "stock " + it.stockFlag;
    if (it.department && !AW_DEPTS.has(it.department)) return "category " + it.department;
  }
  // Check the product name and its sub-category (not the top department: "Incense and Burners" also holds plain burners).
  const sub = String(it.category || "").split(" > ").slice(1).join(" ");
  if (BAN.test(it.name) || BAN.test(sub)) return "regulated/restricted";
  if (DISPLAY.test(it.name)) return "trade display/multipack";
  return "";
}

/** Price the product. `competitor` = cheapest comparable eBay total (GBP) or null. */
export function quote(it, competitor = null) {
  const s = SUPPLIERS[it.supplier];
  const delivery = s.delivery(it.weightKg);
  const p = priceItem({
    supplierCost: Math.round(it.priceExVat * 1.2 * 100) / 100,
    supplierDelivery: delivery,
    feeRate: feeRate(),
    fixedFee: fixedFee(),
    cheapestCompetitor: competitor,
  });
  return { ...p, deliveryGBP: delivery, rrpPence: Math.round(it.rrp * 100), passesRrp: p.pricePence <= Math.round(it.rrp * 100) };
}

export function notes(it) {
  const n = [];
  if (XMAS.test(it.name)) n.push("Christmas – list before early December");
  if (HEAL.test(it.name + " " + (it.category || ""))) n.push("No healing/metaphysical claims in the listing");
  if (/(silver|gold|925)/i.test(it.name) && /jewel/i.test(it.category || "")) n.push("Check hallmarking if solid silver/gold");
  return n;
}

export const queueKey = (it) => "queue/" + it.supplier + "-" + String(it.sku).replace(/[^A-Za-z0-9_.-]/g, "_");
