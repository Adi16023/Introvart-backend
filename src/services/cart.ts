import type { CartItem, Product, ProductVariant } from "@prisma/client";
import type { Db } from "../lib/db";
import { couponDiscount, pincodeInfo, unitPrice, type PricingConfig } from "./pricing";
import { variantAvailable, variantLabel } from "./product-variants";

export type PricedLine = CartItem & {
  unitPrice: number;
  lineTotal: number;
  product: Pick<Product, "id" | "slug" | "stock" | "status" | "artistId" | "fulfilment" | "personalization"> | null;
  problem: string | null;
  variant: ProductVariant | null;
  variantTitle: string | null;
};

export async function loadPricedCart(db: Db, ownerId: string, config: PricingConfig) {
  const items = await db.cartItem.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" } });
  const ids = items.map((item) => item.productId).filter((id): id is string => Boolean(id));
  const products = ids.length
    ? await db.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, slug: true, stock: true, status: true, artistId: true, fulfilment: true, basePrice: true, priceFactor: true, personalization: true, variants: true },
      })
    : [];
  const byId = new Map(products.map((product) => [product.id, product]));

  const lines: PricedLine[] = items.map((item) => {
    const product = item.productId ? byId.get(item.productId) ?? null : null;
    const variant = product?.variants.find((entry) => entry.id === item.variantId) ?? null;
    // Prices always come from the catalogue, never from the client.
    const fulfilment = product ? product.fulfilment : item.fulfilment;
    const price = variant?.price ?? unitPrice(config, {
      fulfilment,
      basePrice: product?.basePrice ?? 0,
      priceFactor: product?.priceFactor ?? 1,
      sizeId: item.sizeId,
      materialId: item.materialId,
      frameId: item.frameId,
    });
    let problem: string | null = null;
    if (item.productId && (!product || product.status !== "approved")) problem = `${item.title} is no longer available`;
    else if (product?.variants.length && !variant) problem = `Choose a valid variant for ${item.title}`;
    else if (item.variantId && !variant) problem = `The selected variant of ${item.title} is no longer available`;
    else if (variant && !variantAvailable(variant, item.quantity)) problem = `The selected variant of ${item.title} has insufficient stock`;
    else if (product && product.stock !== null && product.stock < item.quantity) {
      problem = product.stock === 0 ? `${item.title} is sold out` : `Only ${product.stock} of ${item.title} left`;
    }
    return {
      ...item,
      fulfilment,
      unitPrice: price,
      lineTotal: Math.round(price * item.quantity * 100) / 100,
      variant,
      variantTitle: variant ? variantLabel(variant) : null,
      product: product
        ? { id: product.id, slug: product.slug, stock: product.stock, status: product.status, artistId: product.artistId, fulfilment: product.fulfilment, personalization: product.personalization }
        : null,
      problem,
    };
  });

  return { lines, subtotal: Math.round(lines.reduce((sum, line) => sum + line.lineTotal, 0) * 100) / 100 };
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
  let eligibleSubtotal = subtotal;
  let alreadyUsedByCustomer = false;
  if (couponRow?.collectionSlugs.length) {
    const collections = await db.collection.findMany({ where: { slug: { in: couponRow.collectionSlugs } }, select: { ids: true } });
    const eligibleIds = new Set(collections.flatMap((collection) => collection.ids));
    eligibleSubtotal = Math.round(lines.filter((line) => line.productId && eligibleIds.has(line.productId)).reduce((sum, line) => sum + line.lineTotal, 0) * 100) / 100;
  }
  if (couponRow?.oncePerCustomer) {
    const owners = [{ ownerId: input.ownerId }, ...(input.customerId ? [{ customerId: input.customerId }] : [])];
    alreadyUsedByCustomer = (await db.order.count({ where: { coupon: { equals: couponRow.code, mode: "insensitive" }, settled: true, OR: owners } })) > 0;
  }
  const deal = couponDiscount(couponRow, subtotal, shipping, { eligibleSubtotal, alreadyUsedByCustomer });
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
