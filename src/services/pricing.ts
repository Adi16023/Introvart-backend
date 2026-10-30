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

export function fromPrice(config: PricingConfig, product: { fulfilment: string; basePrice: number; priceFactor: number; variants?: { price: number }[] }) {
  if (product.variants?.length) return Math.min(...product.variants.map((variant) => variant.price));
  if (SELLER_TYPES.includes(product.fulfilment) || product.fulfilment === "commission") return product.basePrice;
  return unitPrice(config, {
    fulfilment: product.fulfilment,
    basePrice: product.basePrice,
    priceFactor: product.priceFactor,
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

export type CouponRow = {
  code: string; label: string; kind: string; value: number; min: number; active: boolean; usageLimit: number | null; used: number;
  startsAt?: Date | null; endsAt?: Date | null; oncePerCustomer?: boolean; collectionSlugs?: string[];
};

export type CouponContext = {
  // Cart value the code may discount: the whole subtotal, or only matching products for collection-scoped codes.
  eligibleSubtotal: number;
  alreadyUsedByCustomer: boolean;
  now?: Date;
};

const rupees = (value: number) => `₹${value.toLocaleString("en-IN")}`;

export function couponDiscount(coupon: CouponRow | null, subtotal: number, shipping: number, context?: CouponContext) {
  const fail = (message: string) => ({ ok: false as const, discount: 0, shippingOff: 0, message });
  if (!coupon || !coupon.active || (coupon.usageLimit !== null && coupon.used >= coupon.usageLimit)) return fail("That code is not active");
  const now = context?.now ?? new Date();
  if (coupon.startsAt && coupon.startsAt > now) return fail("That code is not active yet");
  if (coupon.endsAt && coupon.endsAt < now) return fail("That code has expired");
  if (coupon.oncePerCustomer && context?.alreadyUsedByCustomer) return fail("You have already used this code");
  const scoped = (coupon.collectionSlugs?.length ?? 0) > 0;
  const eligible = scoped ? context?.eligibleSubtotal ?? 0 : subtotal;
  if (scoped && eligible <= 0) return fail("This code applies only to selected collections");
  if (eligible < coupon.min) return fail(`Add ${rupees(coupon.min - eligible)} more to use ${coupon.code}`);
  if (coupon.kind === "percent") {
    return { ok: true as const, discount: Math.round(eligible * (coupon.value / 100)), shippingOff: 0, message: coupon.label };
  }
  if (coupon.kind === "flat") {
    return { ok: true as const, discount: Math.min(coupon.value, eligible), shippingOff: 0, message: coupon.label };
  }
  return { ok: true as const, discount: 0, shippingOff: shipping, message: coupon.label };
}
