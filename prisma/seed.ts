import "dotenv/config";
import { prisma, json } from "../src/lib/db";
import { collections, occasions, policies, posts, colours, rooms, seed } from "./seed-data/seed";

// Usage: npm run db:seed            (only when the database is empty)
//        SEED_RESET=1 npm run db:seed   (wipes everything first)

const parseDate = (text: string, fallback = new Date()) => {
  const value = Date.parse(text.replace(" · ", " "));
  return Number.isNaN(value) ? fallback : new Date(value);
};

async function wipe() {
  await prisma.$transaction([
    prisma.reviewVote.deleteMany(),
    prisma.upload.deleteMany(),
    prisma.review.deleteMany(),
    prisma.printJob.deleteMany(),
    prisma.returnCase.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.order.deleteMany(),
    prisma.cartItem.deleteMany(),
    prisma.wishlistItem.deleteMany(),
    prisma.follow.deleteMany(),
    prisma.recentView.deleteMany(),
    prisma.searchLog.deleteMany(),
    prisma.savedDesign.deleteMany(),
    prisma.payout.deleteMany(),
    prisma.promotion.deleteMany(),
    prisma.commission.deleteMany(),
    prisma.ticket.deleteMany(),
    prisma.b2BLead.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.giftCard.deleteMany(),
    prisma.coupon.deleteMany(),
    prisma.address.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.product.deleteMany(),
    prisma.artist.deleteMany(),
    prisma.collection.deleteMany(),
    prisma.occasion.deleteMany(),
    prisma.banner.deleteMany(),
    prisma.post.deleteMany(),
    prisma.policy.deleteMany(),
    prisma.config.deleteMany(),
  ]);
}

async function main() {
  const existing = await prisma.config.findUnique({ where: { id: 1 } });
  if (existing && !process.env.SEED_RESET) {
    console.log("Database already seeded. Set SEED_RESET=1 to wipe and reseed.");
    return;
  }
  if (existing) await wipe();

  const now = Date.now();
  const customerByName = new Map(seed.customers.map((c) => [c.name, c.id]));

  await prisma.config.create({
    data: {
      id: 1,
      taxRate: seed.config.taxRate,
      freeShippingOver: seed.config.freeShippingOver,
      standardShipping: seed.config.standardShipping,
      expressShipping: seed.config.expressShipping,
      codLimit: seed.config.codLimit,
      personalizationFee: seed.config.personalizationFee,
      sizes: json(seed.config.sizes),
      materials: json(seed.config.materials),
      frames: json(seed.config.frames),
      colours,
      rooms,
      capacity: seed.capacity,
      holidays: seed.holidays,
      partnerName: seed.partnerName,
    },
  });

  await prisma.coupon.createMany({ data: seed.config.coupons.map((c) => ({ ...c })) });

  await prisma.artist.createMany({ data: seed.artists.map((a) => ({ ...a, gst: a.gst ?? null })) });

  await prisma.product.createMany({
    data: seed.artworks.map((a, index) => ({
      ...a,
      moderatorNote: a.moderatorNote ?? null,
      personalization: a.personalization ? json(a.personalization) : undefined,
      createdAt: new Date(now - (seed.artworks.length - index) * 60_000),
    })),
  });
  const artworkByTitle = new Map(seed.artworks.map((a) => [a.title, a.id]));

  await prisma.review.createMany({
    data: seed.reviews.map((r, index) => ({ ...r, photo: r.photo ?? null, createdAt: new Date(now - (seed.reviews.length - index) * 3_600_000) })),
  });

  await prisma.customer.createMany({ data: seed.customers.map((c) => ({ ...c })) });
  await prisma.address.createMany({ data: seed.addresses.map((a) => ({ ...a, customerId: "c1" })) });
  await prisma.savedDesign.createMany({ data: seed.designs.map((d) => ({ ...d, ownerId: "c1" })) });
  await prisma.wishlistItem.createMany({ data: seed.wishlist.map((artworkId) => ({ ownerId: "c1", artworkId })) });
  await prisma.follow.createMany({ data: seed.follows.map((artistId) => ({ ownerId: "c1", artistId })) });
  await prisma.recentView.createMany({ data: seed.recent.map((artworkId, i) => ({ ownerId: "c1", artworkId, at: new Date(now - i * 60_000) })) });
  await prisma.searchLog.createMany({ data: seed.recentSearches.map((query, i) => ({ ownerId: "c1", query, results: 1, createdAt: new Date(now - i * 60_000) })) });

  for (const order of seed.orders) {
    const createdAt = parseDate(order.placedAt);
    const subtotal = order.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const taxable = subtotal - order.discount;
    const payable = Math.max(0, taxable + order.shipping - order.giftCardAmount - order.creditUsed);
    await prisma.order.create({
      data: {
        id: order.id,
        ownerId: order.customerId,
        customerId: order.customerId,
        customerName: order.customerName,
        email: order.email,
        placedAt: order.placedAt,
        createdAt,
        address: json(order.address),
        delivery: order.delivery,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        coupon: order.coupon,
        discount: order.discount,
        shipping: order.shipping,
        giftCardCode: order.giftCardCode,
        giftCardAmount: order.giftCardAmount,
        creditUsed: order.creditUsed,
        subtotal,
        gst: Math.round(taxable - taxable / (1 + seed.config.taxRate)),
        payable,
        gstInvoice: order.gstInvoice,
        settled: true,
        items: {
          create: order.items.map((item) => ({
            id: item.id,
            artworkId: artworkByTitle.get(item.title),
            title: item.title,
            artistName: item.artistName,
            image: item.image,
            fulfilment: item.fulfilment,
            sizeLabel: item.sizeLabel,
            materialLabel: item.materialLabel,
            frameLabel: item.frameLabel,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            status: item.status,
            gift: item.gift,
            giftMessage: item.giftMessage,
            creatorId: item.creatorId,
            deliveredAt: item.status === "delivered" ? new Date(createdAt.getTime() + 5 * 86_400_000) : null,
          })),
        },
      },
    });
  }

  await prisma.printJob.createMany({ data: seed.jobs.map((j) => ({ ...j, defect: j.defect ?? null, awb: j.awb ?? null })) });

  // Return cases in the demo data point at older orders that are not in the order list; give them a delivered stub.
  const known = new Set(seed.orders.map((o) => o.id));
  for (const ret of seed.returns.filter((r) => !known.has(r.orderId))) {
    const artwork = seed.artworks.find((a) => a.title === ret.itemTitle);
    const buyer = seed.customers[1];
    const unitPrice = artwork?.basePrice ?? 0;
    await prisma.order.create({
      data: {
        id: ret.orderId,
        ownerId: buyer.id,
        customerId: buyer.id,
        customerName: buyer.name,
        email: buyer.email,
        placedAt: "20 Sep 2026",
        createdAt: parseDate("20 Sep 2026"),
        address: json({ id: "ad-stub", name: buyer.name, phone: buyer.phone, line: "On file", city: buyer.city, state: "", pincode: "400001", label: "Home" }),
        paymentMethod: "UPI",
        paymentStatus: "paid",
        subtotal: unitPrice,
        payable: unitPrice,
        settled: true,
        items: {
          create: [{
            id: `oi-${ret.orderId}`,
            artworkId: artwork?.id,
            title: ret.itemTitle,
            artistName: artwork?.artistId ?? "",
            image: artwork?.image ?? "",
            fulfilment: artwork?.fulfilment ?? "platform_pod",
            sizeLabel: "A2",
            materialLabel: "Matte",
            frameLabel: "Oak",
            quantity: 1,
            unitPrice,
            status: "return_requested",
            creatorId: artwork?.artistId,
            deliveredAt: parseDate("28 Sep 2026"),
          }],
        },
      },
    });
  }

  await prisma.returnCase.createMany({
    data: seed.returns.map((r) => {
      const order = seed.orders.find((o) => o.id === r.orderId);
      const item = order?.items.find((i) => i.title === r.itemTitle);
      return { ...r, itemId: item?.id ?? `oi-${r.orderId}` };
    }),
  });

  await prisma.commission.createMany({
    data: seed.commissions.map((c) => ({
      ...c,
      ownerId: customerByName.get(c.customerName),
      quote: c.quote ? json(c.quote) : undefined,
      progress: json(c.progress),
    })),
  });

  await prisma.giftCard.createMany({ data: seed.giftCards.map((g) => ({ ...g })) });
  await prisma.ticket.createMany({ data: seed.tickets.map((t) => ({ ...t, ownerId: customerByName.get(t.from), orderId: t.orderId ?? null })) });
  await prisma.b2BLead.createMany({ data: seed.b2b.map((b) => ({ ...b })) });
  await prisma.auditLog.createMany({ data: seed.audit.map((a) => ({ id: a.id, actor: a.actor, action: a.action, at: parseDate(a.at) })) });
  await prisma.banner.createMany({ data: seed.banners.map((b, sort) => ({ ...b, sort })) });

  await prisma.collection.createMany({ data: collections.map((c, sort) => ({ ...c, sort })) });
  await prisma.occasion.createMany({ data: occasions.map((o, sort) => ({ ...o, sort })) });
  await prisma.post.createMany({ data: posts.map((p) => ({ ...p, body: p.lede })) });
  await prisma.policy.createMany({ data: policies.map((p) => ({ ...p })) });

  console.log(
    `Seeded ${seed.artists.length} artists, ${seed.artworks.length} artworks, ${seed.customers.length} customers, ${seed.orders.length} orders.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
