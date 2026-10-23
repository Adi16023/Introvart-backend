import { prisma, type Db } from "../lib/db";
import { notFound } from "../lib/http";

export type SizeOption = { id: string; label: string; cm: string; price: number };
export type MaterialOption = { id: string; label: string; multiplier: number };
export type FrameOption = { id: string; label: string; price: number; swatch: string };

export type PricingConfig = {
  taxRate: number;
  freeShippingOver: number;
  standardShipping: number;
  expressShipping: number;
  codLimit: number;
  personalizationFee: number;
  sizes: SizeOption[];
  materials: MaterialOption[];
  frames: FrameOption[];
};

export type Settings = PricingConfig & {
  colours: string[];
  rooms: string[];
  capacity: number;
  holidays: string;
  partnerName: string;
};

export async function loadConfig(db: Db = prisma): Promise<Settings> {
  const row = await db.config.findUnique({ where: { id: 1 } });
  if (!row) throw notFound("Platform configuration has not been seeded");
  return {
    taxRate: row.taxRate,
    freeShippingOver: row.freeShippingOver,
    standardShipping: row.standardShipping,
    expressShipping: row.expressShipping,
    codLimit: row.codLimit,
    personalizationFee: row.personalizationFee,
    sizes: row.sizes as SizeOption[],
    materials: row.materials as MaterialOption[],
    frames: row.frames as FrameOption[],
    colours: row.colours,
    rooms: row.rooms,
    capacity: row.capacity,
    holidays: row.holidays,
    partnerName: row.partnerName,
  };
}

export const sizeOf = (config: PricingConfig, id: string) => config.sizes.find((item) => item.id === id) ?? config.sizes[1] ?? config.sizes[0];
export const materialOf = (config: PricingConfig, id: string) => config.materials.find((item) => item.id === id) ?? config.materials[0];
export const frameOf = (config: PricingConfig, id: string) => config.frames.find((item) => item.id === id) ?? config.frames[0];

export const SELLER_TYPES = ["original", "seller_fulfilled"];
export const PRESS_TYPES = ["platform_pod", "custom_print", "personalized"];

export function unitPrice(
  config: PricingConfig,
  input: { fulfilment: string; basePrice: number; priceFactor: number; sizeId: string; materialId: string; frameId: string },
) {
  const frame = frameOf(config, input.frameId).price;
  if (SELLER_TYPES.includes(input.fulfilment)) return input.basePrice + frame;
  if (input.fulfilment === "commission") return input.basePrice;
  const size = sizeOf(config, input.sizeId).price;
  const material = materialOf(config, input.materialId).multiplier;
  const extra = input.fulfilment === "personalized" ? config.personalizationFee : 0;
  return Math.round(size * material * input.priceFactor + frame + extra);
}

export function fromPrice(config: PricingConfig, artwork: { fulfilment: string; basePrice: number; priceFactor: number }) {
  if (SELLER_TYPES.includes(artwork.fulfilment) || artwork.fulfilment === "commission") return artwork.basePrice;
  return unitPrice(config, {
    fulfilment: artwork.fulfilment,
    basePrice: artwork.basePrice,
    priceFactor: artwork.priceFactor,
    sizeId: config.sizes[0].id,
    materialId: config.materials[0].id,
    frameId: "none",
  });
}

export function pincodeInfo(pincode: string) {
  const clean = pincode.trim();
  if (!/^[1-9][0-9]{5}$/.test(clean)) return { ok: false, eta: "Enter a 6-digit Indian pincode", remote: false };
  if (clean.startsWith("99")) return { ok: false, eta: "This pincode is outside the current delivery map", remote: true };
  if (clean.startsWith("79") || clean.startsWith("18") || clean.startsWith("69")) {
    return { ok: true, eta: "8–11 days · remote lane", remote: true };
  }
  if (["56", "40", "11", "60"].some((prefix) => clean.startsWith(prefix))) {
    return { ok: true, eta: "3–5 days · metro", remote: false };
  }
  return { ok: true, eta: "5–7 days · standard lane", remote: false };
}

export type CouponRow = { code: string; label: string; kind: string; value: number; min: number; active: boolean; usageLimit: number | null; used: number };

export function couponDiscount(coupon: CouponRow | null, subtotal: number, shipping: number) {
  if (!coupon || !coupon.active || (coupon.usageLimit !== null && coupon.used >= coupon.usageLimit)) {
    return { ok: false as const, discount: 0, shippingOff: 0, message: "That code is not active" };
  }
  if (subtotal < coupon.min) {
    return { ok: false as const, discount: 0, shippingOff: 0, message: `Add ₹${(coupon.min - subtotal).toLocaleString("en-IN")} more to use ${coupon.code}` };
  }
  if (coupon.kind === "percent") {
    return { ok: true as const, discount: Math.round(subtotal * (coupon.value / 100)), shippingOff: 0, message: coupon.label };
  }
  if (coupon.kind === "flat") {
    return { ok: true as const, discount: Math.min(coupon.value, subtotal), shippingOff: 0, message: coupon.label };
  }
  return { ok: true as const, discount: 0, shippingOff: shipping, message: coupon.label };
}
