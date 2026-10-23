import type { CartItem, Artwork } from "@prisma/client";
import type { Db } from "../lib/db";
import { couponDiscount, pincodeInfo, unitPrice, type PricingConfig } from "./pricing";

export type PricedLine = CartItem & {
  unitPrice: number;
  lineTotal: number;
  artwork: Pick<Artwork, "id" | "slug" | "stock" | "status" | "artistId" | "fulfilment" | "personalization"> | null;
  problem: string | null;
};

export async function loadPricedCart(db: Db, ownerId: string, config: PricingConfig) {
  const items = await db.cartItem.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" } });
  const ids = items.map((item) => item.artworkId).filter((id): id is string => Boolean(id));
  const artworks = ids.length
    ? await db.artwork.findMany({
        where: { id: { in: ids } },
        select: { id: true, slug: true, stock: true, status: true, artistId: true, fulfilment: true, basePrice: true, priceFactor: true, personalization: true },
      })
    : [];
  const byId = new Map(artworks.map((artwork) => [artwork.id, artwork]));

  const lines: PricedLine[] = items.map((item) => {
    const artwork = item.artworkId ? byId.get(item.artworkId) ?? null : null;
    // Prices always come from the catalogue, never from the client.
    const fulfilment = artwork ? artwork.fulfilment : item.fulfilment;
    const price = unitPrice(config, {
      fulfilment,
      basePrice: artwork?.basePrice ?? 0,
      priceFactor: artwork?.priceFactor ?? 1,
      sizeId: item.sizeId,
      materialId: item.materialId,
      frameId: item.frameId,
    });
    let problem: string | null = null;
    if (item.artworkId && (!artwork || artwork.status !== "approved")) problem = `${item.title} is no longer available`;
    else if (artwork && artwork.stock !== null && artwork.stock < item.quantity) {
      problem = artwork.stock === 0 ? `${item.title} is sold out` : `Only ${artwork.stock} of ${item.title} left`;
    }
    return {
      ...item,
      fulfilment,
      unitPrice: price,
      lineTotal: price * item.quantity,
      artwork: artwork
        ? { id: artwork.id, slug: artwork.slug, stock: artwork.stock, status: artwork.status, artistId: artwork.artistId, fulfilment: artwork.fulfilment, personalization: artwork.personalization }
        : null,
      problem,
    };
  });

  return { lines, subtotal: lines.reduce((sum, line) => sum + line.lineTotal, 0) };
}

export type TotalsInput = {
  ownerId: string;
  customerId?: string;
  coupon?: string;
  giftCardCode?: string;
  useCredit?: boolean;
  delivery: "standard" | "express";
  pincode?: string;
};

export async function computeTotals(db: Db, config: PricingConfig, input: TotalsInput) {
  const { lines, subtotal } = await loadPricedCart(db, input.ownerId, config);
  const pin = pincodeInfo(input.pincode || "560038");

  let shipping = input.delivery === "express" ? config.expressShipping : config.standardShipping;
  if (subtotal >= config.freeShippingOver && input.delivery === "standard") shipping = 0;
  if (subtotal === 0) shipping = 0;
  if (pin.remote && pin.ok) shipping += 200;

  const couponCode = input.coupon?.trim() ?? "";
  const couponRow = couponCode
    ? await db.coupon.findFirst({ where: { code: { equals: couponCode, mode: "insensitive" } } })
    : null;
  const deal = couponDiscount(couponRow, subtotal, shipping);
  const discount = deal.ok ? deal.discount : 0;
  if (deal.ok) shipping = Math.max(0, shipping - deal.shippingOff);
  const after = Math.max(0, subtotal - discount + shipping);

  const giftCode = input.giftCardCode?.trim() ?? "";
  const giftCard = giftCode
    ? await db.giftCard.findFirst({ where: { code: { equals: giftCode, mode: "insensitive" }, status: "active" } })
    : null;
  const giftCardAmount = giftCard ? Math.min(giftCard.balance, after) : 0;

  const customer = input.customerId ? await db.customer.findUnique({ where: { id: input.customerId } }) : null;
  const creditUsed = input.useCredit && customer ? Math.min(customer.credit, after - giftCardAmount) : 0;
  const payable = Math.max(0, after - giftCardAmount - creditUsed);
  const taxable = subtotal - discount;
  const gst = Math.round(taxable - taxable / (1 + config.taxRate));

  const totals = {
    subtotal,
    discount,
    shipping,
    giftCardAmount,
    creditUsed,
    payable,
    gst,
    message: couponCode ? deal.message : "",
    couponOk: couponCode ? deal.ok : true,
    giftCardOk: giftCode ? Boolean(giftCard) : true,
    serviceable: input.pincode ? pin.ok : true,
    eta: pin.eta,
    codAllowed: payable > 0 && payable <= config.codLimit && pin.ok && !pin.remote,
  };
  return { totals, lines, couponRow, giftCard, customer };
}
