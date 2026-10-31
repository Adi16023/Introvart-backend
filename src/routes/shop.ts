import { Router } from "express";
import { z } from "zod";
import { json, prisma } from "../lib/db";
import { badRequest, conflict, notFound, param, parse, uid } from "../lib/http";
import { needCustomer, needOwner } from "../lib/identity";
import { productsByIds } from "../services/catalog";
import { computeTotals, loadPricedCart } from "../services/cart";
import { commissions } from "../services/commissions";
import { resolveMedia, resolveOne } from "../lib/media";
import { deleteObject } from "../lib/storage";
import { cancelOrder, getOrder, invoiceOf, placeOrder } from "../services/orders";
import { confirmPayment, startPayment } from "../services/payments";
import { loadConfig } from "../services/pricing";
import { openReturn } from "../services/returns";
import { customerTracking } from "../services/shipping";
import { selectedVariant, variantAvailable } from "../services/product-variants";
import {
  addCustomerAddress,
  deleteCustomerAddress,
  listCustomerAddresses,
  patchCustomerAddress,
  saveCustomerAddressIfMissing,
} from "../services/customer-addresses";
import type { ProductVariant } from "@prisma/client";

export const shopRouter = Router();

const phone = z.string().regex(/^[0-9+\-\s]{10,15}$/, "Enter a valid mobile number");

// ───────── session (no OTP yet: find-or-create by phone or email) ─────────

shopRouter.post("/session", async (req, res) => {
  const body = parse(z.object({ phone: phone.optional(), email: z.string().email().optional(), name: z.string().min(1).max(80).optional(), city: z.string().max(60).optional() }), req.body);
  if (!body.phone && !body.email) throw badRequest("Send a phone or an email");
  const clean = body.phone?.replace(/[\s\-]/g, "");
  let customer = await prisma.customer.findFirst({
    where: { OR: [...(clean ? [{ phone: clean }] : []), ...(body.email ? [{ email: body.email.toLowerCase() }] : [])] },
  });
  if (!customer) {
    const name = body.name ?? "New customer";
    customer = await prisma.customer.create({
      data: {
        id: uid("c"),
        name,
        email: body.email?.toLowerCase() ?? "",
        phone: clean ?? "",
        city: body.city ?? "",
        referral: `${name.split(" ")[0].toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`,
      },
    });
  }
  // A guest cart carries over when the shopper signs in.
  const guest = req.header("x-guest-id");
  if (guest) await mergeGuest(`guest:${guest}`, customer.id);
  res.json(customer);
});

async function mergeGuest(guestOwner: string, customerId: string) {
  const [items, wishes, follows] = await Promise.all([
    prisma.cartItem.findMany({ where: { ownerId: guestOwner } }),
    prisma.wishlistItem.findMany({ where: { ownerId: guestOwner } }),
    prisma.follow.findMany({ where: { ownerId: guestOwner } }),
  ]);
  await prisma.$transaction([
    prisma.cartItem.updateMany({ where: { ownerId: guestOwner }, data: { ownerId: customerId } }),
    prisma.wishlistItem.createMany({ data: wishes.map((w) => ({ ownerId: customerId, productId: w.productId })), skipDuplicates: true }),
    prisma.wishlistItem.deleteMany({ where: { ownerId: guestOwner } }),
    prisma.follow.createMany({ data: follows.map((f) => ({ ownerId: customerId, artistId: f.artistId })), skipDuplicates: true }),
    prisma.follow.deleteMany({ where: { ownerId: guestOwner } }),
  ]);
  return items.length;
}

shopRouter.post("/cart/merge", needCustomer, async (req, res) => {
  const { guestId } = parse(z.object({ guestId: z.string().min(1) }), req.body);
  res.json({ moved: await mergeGuest(`guest:${guestId}`, req.customerId!) });
});

// ───────── profile ─────────

shopRouter.get("/me", needCustomer, async (req, res) => {
  res.json(await prisma.customer.findUnique({ where: { id: req.customerId } }));
});

shopRouter.patch("/me", needCustomer, async (req, res) => {
  const body = parse(z.object({ name: z.string().min(1).max(80).optional(), email: z.string().email().optional(), phone: phone.optional(), city: z.string().max(60).optional() }), req.body);
  res.json(await prisma.customer.update({ where: { id: req.customerId }, data: { ...body, ...(body.email ? { email: body.email.toLowerCase() } : {}) } }));
});

shopRouter.get("/me/export", needCustomer, async (req, res) => {
  const id = req.customerId!;
  const [customer, addresses, orders, designs, wishlist, commissionRows, tickets] = await Promise.all([
    prisma.customer.findUnique({ where: { id } }),
    listCustomerAddresses(id),
    prisma.order.findMany({ where: { customerId: id }, include: { items: true, returns: true } }),
    prisma.saved.findMany({ where: { ownerId: id } }),
    prisma.wishlistItem.findMany({ where: { ownerId: id } }),
    prisma.commission.findMany({ where: { ownerId: id } }),
    prisma.ticket.findMany({ where: { ownerId: id } }),
  ]);
  res.json({ customer, addresses, orders, designs, wishlist, commissions: commissionRows, tickets });
});

// Orders keep their rows for tax records; personal data and private uploads are removed from the account.
shopRouter.delete("/me", needCustomer, async (req, res) => {
  const id = req.customerId!;
  const files = await prisma.upload.findMany({ where: { ownerId: id }, select: { key: true } });
  await Promise.allSettled(files.map((file) => deleteObject(file.key)));
  await prisma.$transaction([
    prisma.upload.deleteMany({ where: { ownerId: id } }),
    prisma.saved.deleteMany({ where: { ownerId: id } }),
    prisma.wishlistItem.deleteMany({ where: { ownerId: id } }),
    prisma.follow.deleteMany({ where: { ownerId: id } }),
    prisma.recentView.deleteMany({ where: { ownerId: id } }),
    prisma.cartItem.deleteMany({ where: { ownerId: id } }),
    prisma.customer.update({ where: { id }, data: { name: "Deleted customer", email: "", phone: "", city: "", credit: 0, addresses: json([]) } }),
  ]);
  res.status(204).end();
});

// ───────── addresses ─────────

const addressBody = z.object({
  name: z.string().min(1).max(80),
  phone,
  line: z.string().min(3).max(200),
  city: z.string().min(1).max(60),
  state: z.string().min(1).max(60),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/, "Enter a 6-digit pincode"),
  label: z.string().max(30).default("Home"),
});

shopRouter.get("/me/addresses", needCustomer, async (req, res) => {
  res.json(await listCustomerAddresses(req.customerId!));
});

shopRouter.post("/me/addresses", needCustomer, async (req, res) => {
  const body = parse(addressBody, req.body);
  res.status(201).json(await addCustomerAddress(req.customerId!, body));
});

shopRouter.patch("/me/addresses/:id", needCustomer, async (req, res) => {
  const body = parse(addressBody.partial(), req.body);
  res.json(await patchCustomerAddress(req.customerId!, param(req, "id"), body));
});

shopRouter.delete("/me/addresses/:id", needCustomer, async (req, res) => {
  await deleteCustomerAddress(req.customerId!, param(req, "id"));
  res.status(204).end();
});

// Everything below needs a customer or guest identity.
shopRouter.use(["/cart", "/checkout", "/orders", "/me", "/reviews", "/commissions"], needOwner);

// ───────── cart ─────────

const cartBody = z.object({
  productId: z.string().optional(),
  variantId: z.string().optional(),
  title: z.string().min(1).max(160).optional(),
  artistName: z.string().max(120).optional(),
  image: z.string().min(1).optional(),
  sizeId: z.string().default("a3"),
  materialId: z.string().default("matte"),
  frameId: z.string().default("none"),
  quantity: z.coerce.number().int().min(1).max(20).default(1),
  personalization: z.record(z.string(), z.string().max(120)).optional(),
  note: z.string().max(300).optional(),
  gift: z.boolean().default(false),
  giftMessage: z.string().max(300).default(""),
});

shopRouter.get("/cart", async (req, res) => {
  const config = await loadConfig();
  const cart = await loadPricedCart(prisma, req.ownerId!, config);
  res.json({ items: cart.lines, subtotal: cart.subtotal, count: cart.lines.reduce((sum, line) => sum + line.quantity, 0) });
});

shopRouter.post("/cart/items", async (req, res) => {
  const body = parse(cartBody, req.body);
  const config = await loadConfig();
  if (!config.sizes.some((s) => s.id === body.sizeId)) throw badRequest("Unknown size");
  if (!config.materials.some((m) => m.id === body.materialId)) throw badRequest("Unknown material");
  if (!config.frames.some((f) => f.id === body.frameId)) throw badRequest("Unknown frame");

  let data: { productId: string | null; title: string; artistName: string; image: string; fulfilment: string };
  let chosenVariant: ProductVariant | null = null;
  if (body.productId) {
    const product = await prisma.product.findFirst({ where: { id: body.productId, status: "approved", artist: { suspended: false } }, include: { artist: true, variants: true } });
    if (!product) throw notFound("Product not available");
    if (product.giftCard) throw badRequest("Purchase gift cards through the gift-card page");
    const variant = selectedVariant(product.variants, body.variantId);
    chosenVariant = variant;
    if (variant && !variantAvailable(variant, body.quantity)) throw conflict("The selected variant has insufficient stock");
    if (product.fulfilment === "commission") throw badRequest("Commissions are requested, not added to the cart");
    if (product.stock !== null && product.stock < 1) throw conflict(`${product.title} is sold out`);
    if (product.fulfilment === "personalized") {
      const fields = (product.personalization as { key: string; label: string }[] | null) ?? [];
      const missing = fields.find((field) => !body.personalization?.[field.key]?.trim());
      if (missing) throw badRequest(`${missing.label} is required`);
    }
    data = {
      productId: product.id,
      title: body.title ?? product.title,
      artistName: product.artist.name,
      image: product.image,
      fulfilment: product.fulfilment,
    };
  } else {
    if (body.variantId) throw badRequest("A variant requires a product");
    if (!body.title || !body.image) throw badRequest("Custom items need a title and an image");
    const image = await resolveOne(req, body.image, ["custom-print"]);
    data = { productId: null, title: body.title, artistName: body.artistName ?? "Your photograph", image, fulfilment: "custom_print" };
  }

  const candidates = await prisma.cartItem.findMany({
    where: { ownerId: req.ownerId!, productId: data.productId, variantId: body.variantId ?? null, title: data.title, sizeId: body.sizeId, materialId: body.materialId, frameId: body.frameId },
  });
  const existing = candidates.find((item) => JSON.stringify(item.personalization ?? {}) === JSON.stringify(body.personalization ?? {}));
  if (existing) {
    const quantity = Math.min(20, existing.quantity + body.quantity);
    if (chosenVariant && !variantAvailable(chosenVariant, quantity)) throw conflict("The selected variant has insufficient stock");
    const item = await prisma.cartItem.update({ where: { id: existing.id }, data: { quantity } });
    res.json(item);
    return;
  }
  const item = await prisma.cartItem.create({
    data: {
      id: uid("CI"),
      ownerId: req.ownerId!,
      ...data,
      variantId: body.variantId,
      sizeId: body.sizeId,
      materialId: body.materialId,
      frameId: body.frameId,
      quantity: body.quantity,
      personalization: body.personalization ? json(body.personalization) : undefined,
      note: body.note,
      gift: body.gift,
      giftMessage: body.giftMessage,
    },
  });
  res.status(201).json(item);
});

shopRouter.patch("/cart/items/:id", async (req, res) => {
  const body = parse(
    z.object({
      quantity: z.coerce.number().int().min(0).max(20).optional(),
      sizeId: z.string().optional(),
      materialId: z.string().optional(),
      frameId: z.string().optional(),
      gift: z.boolean().optional(),
      giftMessage: z.string().max(300).optional(),
      note: z.string().max(300).optional(),
      personalization: z.record(z.string(), z.string().max(120)).optional(),
    }),
    req.body,
  );
  const id = param(req, "id");
  const item = await prisma.cartItem.findFirst({ where: { id, ownerId: req.ownerId } });
  if (!item) throw notFound("Cart item not found");
  if (body.quantity === 0) {
    await prisma.cartItem.delete({ where: { id } });
    res.status(204).end();
    return;
  }
  const config = await loadConfig();
  if (body.sizeId && !config.sizes.some((s) => s.id === body.sizeId)) throw badRequest("Unknown size");
  if (body.materialId && !config.materials.some((m) => m.id === body.materialId)) throw badRequest("Unknown material");
  if (body.frameId && !config.frames.some((f) => f.id === body.frameId)) throw badRequest("Unknown frame");
  const { personalization, ...rest } = body;
  res.json(await prisma.cartItem.update({ where: { id }, data: { ...rest, ...(personalization ? { personalization: json(personalization) } : {}) } }));
});

shopRouter.delete("/cart/items/:id", async (req, res) => {
  await prisma.cartItem.deleteMany({ where: { id: param(req, "id"), ownerId: req.ownerId } });
  res.status(204).end();
});

shopRouter.delete("/cart", async (req, res) => {
  await prisma.cartItem.deleteMany({ where: { ownerId: req.ownerId } });
  res.status(204).end();
});

// ───────── checkout ─────────

const totalsBody = z.object({
  coupon: z.string().max(40).optional(),
  giftCardCode: z.string().max(40).optional(),
  useCredit: z.boolean().default(false),
  delivery: z.enum(["standard", "express"]).default("standard"),
  pincode: z.string().max(10).optional(),
});

shopRouter.post("/checkout/totals", async (req, res) => {
  const body = parse(totalsBody, req.body);
  const config = await loadConfig();
  const { totals, lines } = await computeTotals(prisma, config, { ownerId: req.ownerId!, customerId: req.customerId, ...body });
  res.json({ ...totals, problems: lines.filter((l) => l.problem).map((l) => l.problem), items: lines.length });
});

const orderBody = totalsBody.extend({
  address: addressBody.extend({ id: z.string().optional() }),
  paymentMethod: z.enum(["online", "cod"]),
  email: z.string().email().optional(),
  name: z.string().min(1).max(80).optional(),
  gstInvoice: z.boolean().default(true),
  saveAddress: z.boolean().default(true),
});

shopRouter.post("/orders", async (req, res) => {
  const body = parse(orderBody, req.body);
  const customer = req.customerId ? await prisma.customer.findUnique({ where: { id: req.customerId } }) : null;
  const email = body.email ?? customer?.email;
  if (!email) throw badRequest("An email is needed for the order receipt");
  const order = await placeOrder({
    ownerId: req.ownerId!,
    customerId: customer?.id,
    address: body.address,
    delivery: body.delivery,
    paymentMethod: body.paymentMethod,
    coupon: body.coupon,
    giftCardCode: body.giftCardCode,
    useCredit: body.useCredit,
    email,
    name: body.name ?? body.address.name,
    gstInvoice: body.gstInvoice,
  });
  if (customer && body.saveAddress) {
    const { id: _id, ...fields } = body.address;
    await saveCustomerAddressIfMissing(customer.id, { ...fields, label: fields.label ?? "Home" });
  }
  res.status(201).json(order);
});

async function ownOrder(req: { ownerId?: string; customerId?: string }, id: string) {
  const order = await getOrder(id);
  const mine = (req.ownerId && order.ownerId === req.ownerId) || (req.customerId && order.customerId === req.customerId);
  if (!mine) throw notFound("Order not found");
  return order;
}

// Online payments run through Cashfree: the browser opens the payment popup with a session created here,
// then asks us to confirm. We read the outcome from Cashfree ourselves; the browser is never trusted.
shopRouter.post("/orders/:id/payment/session", async (req, res) => {
  await ownOrder(req, param(req, "id"));
  res.json(await startPayment(param(req, "id")));
});

shopRouter.post("/orders/:id/payment/verify", async (req, res) => {
  await ownOrder(req, param(req, "id"));
  res.json(await confirmPayment(param(req, "id")));
});

shopRouter.get("/me/orders", async (req, res) => {
  const or = [
    ...(req.ownerId ? [{ ownerId: req.ownerId }] : []),
    ...(req.customerId ? [{ customerId: req.customerId }] : []),
  ];
  res.json(await prisma.order.findMany({ where: { OR: or }, include: { items: true }, orderBy: { createdAt: "desc" } }));
});

shopRouter.get("/me/orders/:id", async (req, res) => {
  res.json(await ownOrder(req, param(req, "id")));
});

shopRouter.get("/me/orders/:id/tracking", async (req, res) => {
  await ownOrder(req, param(req, "id"));
  res.json(await customerTracking(param(req, "id")));
});

shopRouter.get("/me/orders/:id/invoice", async (req, res) => {
  res.json(invoiceOf(await ownOrder(req, param(req, "id"))));
});

shopRouter.post("/me/orders/:id/cancel", async (req, res) => {
  await ownOrder(req, param(req, "id"));
  res.json(await cancelOrder(param(req, "id")));
});

// ───────── returns ─────────

shopRouter.get("/me/returns", needCustomer, async (req, res) => {
  res.json(await prisma.returns.findMany({ where: { order: { customerId: req.customerId } }, orderBy: { createdAt: "desc" } }));
});

shopRouter.post("/me/returns", needCustomer, async (req, res) => {
  const body = parse(
    z.object({
      orderId: z.string(),
      itemId: z.string().optional(),
      itemTitle: z.string().optional(),
      reason: z.string().min(3).max(500),
      type: z.enum(["refund", "replacement", "reprint"]),
      evidence: z.string().max(2000).optional(),
      photos: z.array(z.string()).max(5).default([]),
    }).refine((v) => v.itemId || v.itemTitle, "Send itemId or itemTitle"),
    req.body,
  );
  const photos = await resolveMedia(req, body.photos, ["return"], "photos");
  res.status(201).json(await openReturn({ customerId: req.customerId!, ...body, photos }));
});

// ───────── reviews ─────────

shopRouter.post("/reviews", async (req, res) => {
  const body = parse(
    z.object({
      productId: z.string(),
      rating: z.coerce.number().int().min(1).max(5),
      text: z.string().min(3).max(2000),
      photo: z.string().optional(),
      author: z.string().min(1).max(80).optional(),
    }),
    req.body,
  );
  const product = await prisma.product.findUnique({ where: { id: body.productId } });
  if (!product) throw notFound("Product not found");
  const customer = req.customerId ? await prisma.customer.findUnique({ where: { id: req.customerId } }) : null;
  const author = customer?.name ?? body.author;
  if (!author) throw badRequest("Tell us your name");
  const duplicate = await prisma.review.findFirst({ where: { productId: body.productId, ownerId: req.ownerId } });
  if (duplicate) throw conflict("You already reviewed this work");
  const bought = await prisma.orderItem.count({
    where: { productId: body.productId, status: { in: ["shipped", "delivered"] }, order: { OR: [{ ownerId: req.ownerId }, ...(req.customerId ? [{ customerId: req.customerId }] : [])] } },
  });
  const photo = body.photo ? await resolveOne(req, body.photo, ["review"], "photo") : undefined;
  const review = await prisma.review.create({
    data: { id: uid("RV"), productId: body.productId, ownerId: req.ownerId, author, rating: body.rating, text: body.text, photo, status: "pending", verified: bought > 0 },
  });
  res.status(201).json(review);
});

shopRouter.post("/reviews/:id/helpful", async (req, res) => {
  const id = param(req, "id");
  const updated = await prisma.$queryRaw<{ helpful: number }[]>`
    UPDATE "Review"
    SET "helpful" = "helpful" + 1,
        "votes" = "votes" || jsonb_build_array(${req.ownerId!}::text)
    WHERE "id" = ${id}
      AND "status" = 'approved'
      AND NOT ("votes" @> jsonb_build_array(${req.ownerId!}::text))
    RETURNING "helpful"
  `;
  if (!updated.length) {
    const review = await prisma.review.findFirst({ where: { id, status: "approved" }, select: { id: true } });
    if (!review) throw notFound("Review not found");
    throw conflict("You already marked this helpful");
  }
  res.json({ helpful: updated[0].helpful });
});

// ───────── designs ─────────

shopRouter.get("/me/designs", async (req, res) => {
  res.json(await prisma.saved.findMany({ where: { ownerId: req.ownerId }, orderBy: { createdAt: "desc" } }));
});

shopRouter.post("/me/designs", async (req, res) => {
  const body = parse(z.object({ title: z.string().min(1).max(120), image: z.string().min(1), kind: z.string().max(40), detail: z.string().max(200) }), req.body);
  const image = await resolveOne(req, body.image, ["custom-print"]);
  res.status(201).json(await prisma.saved.create({ data: { id: uid("DS"), ownerId: req.ownerId!, ...body, image } }));
});

shopRouter.delete("/me/designs/:id", async (req, res) => {
  await prisma.saved.deleteMany({ where: { id: param(req, "id"), ownerId: req.ownerId } });
  res.status(204).end();
});

// ───────── wishlist, follows, history ─────────

shopRouter.get("/me/wishlist", async (req, res) => {
  const rows = await prisma.wishlistItem.findMany({ where: { ownerId: req.ownerId }, orderBy: { createdAt: "desc" } });
  res.json(await productsByIds(rows.map((row) => row.productId)));
});

shopRouter.put("/me/wishlist/:productId", async (req, res) => {
  const productId = param(req, "productId");
  if (!(await prisma.product.findUnique({ where: { id: productId }, select: { id: true } }))) throw notFound("Product not found");
  await prisma.wishlistItem.upsert({ where: { ownerId_productId: { ownerId: req.ownerId!, productId } }, create: { ownerId: req.ownerId!, productId }, update: {} });
  res.status(204).end();
});

shopRouter.delete("/me/wishlist/:productId", async (req, res) => {
  await prisma.wishlistItem.deleteMany({ where: { ownerId: req.ownerId, productId: param(req, "productId") } });
  res.status(204).end();
});

shopRouter.get("/me/follows", async (req, res) => {
  const rows = await prisma.follow.findMany({ where: { ownerId: req.ownerId } });
  const artists = await prisma.artist.findMany({ where: { id: { in: rows.map((r) => r.artistId) } }, select: { id: true, slug: true, name: true, city: true, portrait: true } });
  res.json(artists);
});

shopRouter.put("/me/follows/:artistId", async (req, res) => {
  const artistId = param(req, "artistId");
  if (!(await prisma.artist.findUnique({ where: { id: artistId }, select: { id: true } }))) throw notFound("Artist not found");
  await prisma.follow.upsert({ where: { ownerId_artistId: { ownerId: req.ownerId!, artistId } }, create: { ownerId: req.ownerId!, artistId }, update: {} });
  res.status(204).end();
});

shopRouter.delete("/me/follows/:artistId", async (req, res) => {
  await prisma.follow.deleteMany({ where: { ownerId: req.ownerId, artistId: param(req, "artistId") } });
  res.status(204).end();
});

shopRouter.get("/me/recent", async (req, res) => {
  const rows = await prisma.recentView.findMany({ where: { ownerId: req.ownerId }, orderBy: { at: "desc" }, take: 8 });
  res.json(await productsByIds(rows.map((row) => row.productId)));
});

shopRouter.post("/me/recent/:productId", async (req, res) => {
  const productId = param(req, "productId");
  if (!(await prisma.product.findUnique({ where: { id: productId }, select: { id: true } }))) throw notFound("Product not found");
  await prisma.recentView.upsert({ where: { ownerId_productId: { ownerId: req.ownerId!, productId } }, create: { ownerId: req.ownerId!, productId }, update: { at: new Date() } });
  res.status(204).end();
});

shopRouter.get("/me/searches", async (req, res) => {
  const rows = await prisma.searchHistory.findMany({ where: { ownerId: req.ownerId }, orderBy: { createdAt: "desc" }, take: 40 });
  res.json([...new Set(rows.map((row) => row.query))].slice(0, 6));
});

shopRouter.delete("/me/searches", async (req, res) => {
  await prisma.searchHistory.deleteMany({ where: { ownerId: req.ownerId } });
  res.status(204).end();
});

// ───────── commissions (customer side) ─────────

shopRouter.post("/commissions", async (req, res) => {
  const body = parse(
    z.object({
      artistId: z.string().optional(),
      artistSlug: z.string().optional(),
      name: z.string().max(80).optional(),
      medium: z.string().min(1).max(60),
      size: z.string().min(1).max(60),
      style: z.string().max(120).default(""),
      notes: z.string().min(3).max(3000),
      budget: z.coerce.number().int().min(1000).max(10000000),
      deadline: z.string().max(40).default(""),
      references: z.array(z.string()).max(5).default([]),
    }).refine((v) => v.artistId || v.artistSlug, "Pick an artist"),
    req.body,
  );
  const references = await resolveMedia(req, body.references, ["commission"], "references");
  const artist = await prisma.artist.findFirst({ where: body.artistId ? { id: body.artistId } : { slug: body.artistSlug } });
  if (!artist || artist.suspended || !artist.commissionEnabled) throw conflict("This artist is not taking commissions");
  const customer = req.customerId ? await prisma.customer.findUnique({ where: { id: req.customerId } }) : null;
  const created = await prisma.commission.create({
    data: {
      id: uid("COM"),
      ownerId: req.ownerId,
      customerName: customer?.name ?? body.name ?? "Guest",
      artistId: artist.id,
      medium: body.medium,
      size: body.size,
      style: body.style,
      notes: body.notes,
      budget: body.budget,
      deadline: body.deadline,
      references,
    },
  });
  res.status(201).json(created);
});

shopRouter.get("/me/commissions", async (req, res) => {
  res.json(await prisma.commission.findMany({ where: { ownerId: req.ownerId }, orderBy: { createdAt: "desc" }, include: { artist: { select: { id: true, slug: true, name: true } } } }));
});

shopRouter.get("/commissions/:id", async (req, res) => {
  const commission = await prisma.commission.findFirst({
    where: { id: param(req, "id"), ownerId: req.ownerId },
    include: { artist: { select: { id: true, slug: true, name: true, portrait: true } } },
  });
  if (!commission) throw notFound("Request not found");
  res.json(commission);
});

shopRouter.post("/commissions/:id/accept", async (req, res) => res.json(await commissions.accept(param(req, "id"), req.ownerId!)));
shopRouter.post("/commissions/:id/decline", async (req, res) => res.json(await commissions.declineQuote(param(req, "id"), req.ownerId!)));
shopRouter.post("/commissions/:id/approve", async (req, res) => res.json(await commissions.approveFinal(param(req, "id"), req.ownerId!)));
shopRouter.post("/commissions/:id/revision", async (req, res) => {
  const { message } = parse(z.object({ message: z.string().max(1000).default("") }), req.body);
  res.json(await commissions.requestRevision(param(req, "id"), req.ownerId!, message));
});
shopRouter.post("/commissions/:id/messages", async (req, res) => {
  const { message } = parse(z.object({ message: z.string().min(1).max(1000) }), req.body);
  res.json(await commissions.message(param(req, "id"), req.ownerId!, null, message));
});
