import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { json, prisma, transaction, type Tx } from "../lib/db";
import { badRequest, conflict, uid } from "../lib/http";
import { audit } from "./audit";

const money = z.number().finite().min(0).max(10_000_000).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, "Use at most two decimal places");
const imageUrl = z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Use an HTTPS image URL");
export const optionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  linkedTo: z.string().max(500).default(""),
});
export const variantSchema = z.object({
  optionValues: z.array(z.string().trim().min(1).max(200)).max(3).default([]),
  sku: z.string().max(200).default(""),
  barcode: z.string().max(200).default(""),
  price: money,
  compareAtPrice: money.nullable().default(null),
  inventoryTracker: z.string().max(100).default(""),
  inventoryQuantity: z.number().int().min(-1_000_000).max(1_000_000).default(0),
  inventoryPolicy: z.enum(["deny", "continue"]).default("deny"),
  fulfillmentService: z.string().max(100).default("manual"),
  requiresShipping: z.boolean().default(true),
  taxable: z.boolean().default(true),
  grams: z.number().finite().min(0).default(0),
  weightUnit: z.enum(["g", "kg", "oz", "lb"]).default("kg"),
  image: imageUrl.or(z.literal("")).default(""),
  taxCode: z.string().max(200).default(""),
  costPerItem: money.nullable().default(null),
  unitPriceMeasure: z.record(z.string(), z.string()).default({}),
  packedLength: z.number().finite().min(0).nullable().default(null),
  packedWidth: z.number().finite().min(0).nullable().default(null),
  packedHeight: z.number().finite().min(0).nullable().default(null),
  packedDimensionUnit: z.string().max(20).default(""),
});
export const productSchema = z.object({
  handle: z.string().trim().min(1).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and hyphens"),
  title: z.string().trim().min(1).max(200),
  artistId: z.string().min(1).optional(),
  vendor: z.string().trim().max(200).default(""),
  descriptionHtml: z.string().max(100_000).default(""),
  category: z.string().max(500).default(""),
  productType: z.string().max(200).default(""),
  tags: z.array(z.string().max(200)).max(200).default([]),
  published: z.boolean().default(true),
  catalogStatus: z.enum(["active", "draft", "archived"]).default("draft"),
  giftCard: z.boolean().default(false),
  seoTitle: z.string().max(500).default(""),
  seoDescription: z.string().max(2000).default(""),
  fulfilment: z.enum(["platform_pod", "seller_fulfilled", "original", "personalized"]).default("platform_pod"),
  options: z.array(optionSchema).max(3).default([]),
  images: z.array(z.object({ src: imageUrl, position: z.number().int().positive(), alt: z.string().max(1000).default("") })).max(100),
  variants: z.array(variantSchema).min(1).max(200),
  metafields: z.record(z.string(), z.string()).default({}),
  googleShopping: z.record(z.string(), z.string()).default({}),
  sourceRows: z.array(z.record(z.string(), z.string())).max(1000).default([]),
}).superRefine((product, context) => {
  if (product.published && product.catalogStatus === "active" && !product.images.length) {
    context.addIssue({ code: "custom", path: ["images"], message: "An active published product needs at least one image" });
  }
  const keys = new Set<string>();
  const skus = new Set<string>();
  const positions = new Set<number>();
  for (const [index, variant] of product.variants.entries()) {
    if (variant.optionValues.length !== product.options.length) {
      context.addIssue({ code: "custom", path: ["variants", index, "optionValues"], message: "Supply a value for every product option" });
    }
    const key = JSON.stringify(variant.optionValues);
    if (keys.has(key)) context.addIssue({ code: "custom", path: ["variants", index], message: "Duplicate option combination" });
    keys.add(key);
    if (variant.sku && skus.has(variant.sku)) context.addIssue({ code: "custom", path: ["variants", index, "sku"], message: "Duplicate SKU" });
    if (variant.sku) skus.add(variant.sku);
  }
  for (const [index, image] of product.images.entries()) {
    if (positions.has(image.position)) context.addIssue({ code: "custom", path: ["images", index, "position"], message: "Duplicate image position" });
    positions.add(image.position);
  }
  if (new Set(product.options.map((option) => option.name.toLowerCase())).size !== product.options.length) {
    context.addIssue({ code: "custom", path: ["options"], message: "Option names must be distinct" });
  }
});

export type ProductInput = z.infer<typeof productSchema>;
export const productInclude = { variants: { orderBy: { sort: "asc" as const } }, images: { orderBy: { position: "asc" as const } } };

export function plainDescription(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

async function productArtist(tx: Tx, input: ProductInput, vendors = new Map<string, string>()) {
  const vendor = input.vendor || "Introvart";
  let artistId = input.artistId;
  if (artistId) {
    if (!await tx.artist.findUnique({ where: { id: artistId }, select: { id: true } })) throw badRequest("Unknown artist");
  } else {
    const slug = `vendor-${Buffer.from(vendor.toLowerCase()).toString("hex")}`;
    artistId = vendors.get(slug);
    if (!artistId) {
      const artist = await tx.artist.upsert({
        where: { slug },
        update: {},
        create: {
          id: uid("VENDOR"), slug, name: vendor, bio: "Product vendor",
          verified: true, styles: [], mediums: [],
        },
      });
      artistId = artist.id;
      vendors.set(slug, artistId);
    }
  }
  return artistId;
}

function productData(input: ProductInput, artistId: string): Prisma.ProductCreateManyInput {
  const orientation = input.metafields["Orientation (product.metafields.shopify.orientation)"]?.toLowerCase();
  return {
    id: uid("PROD"), slug: input.handle, title: input.title, artistId,
    vendor: input.vendor || "Introvart", descriptionHtml: input.descriptionHtml, story: plainDescription(input.descriptionHtml),
    image: [...input.images].sort((a, b) => a.position - b.position)[0]?.src ?? "",
    category: input.category, productType: input.productType, tags: input.tags,
    published: input.published, catalogStatus: input.catalogStatus,
    status: input.published && input.catalogStatus === "active" ? "approved" : "draft",
    giftCard: input.giftCard, seoTitle: input.seoTitle, seoDescription: input.seoDescription,
    fulfilment: input.fulfilment, stock: null,
    basePrice: Math.floor(Math.min(...input.variants.map((variant) => variant.price))),
    colours: (input.metafields["Color (product.metafields.shopify.color-pattern)"] || "").split(";").map((value) => value.trim()).filter(Boolean),
    rooms: [], occasions: [], orientation: ["portrait", "landscape", "square"].includes(orientation) ? orientation : "portrait",
    options: json(input.options), metafields: json(input.metafields), googleShopping: json(input.googleShopping), sourceRows: json(input.sourceRows),
  };
}

async function insertProduct(tx: Tx, input: ProductInput) {
  const artistId = await productArtist(tx, input);
  return tx.product.create({
    data: {
      ...productData(input, artistId),
      variants: { create: input.variants.map((variant, sort) => ({ ...variant, unitPriceMeasure: json(variant.unitPriceMeasure), sort })) },
      images: { create: input.images },
    },
    include: productInclude,
  });
}

export async function createProduct(input: ProductInput, actor: string) {
  return transaction(async (tx) => {
    if (await tx.product.findUnique({ where: { slug: input.handle }, select: { id: true } })) throw conflict(`Product handle "${input.handle}" already exists`);
    const result = await insertProduct(tx, input);
    await audit(tx, actor, `Created product "${input.title}"`);
    return result;
  });
}

export async function importProducts(products: ProductInput[], actor: string, replace = false) {
  if (!products.length || products.length > 1000) throw badRequest("Import between 1 and 1000 products");
  return prisma.$transaction(async (tx) => {
    const handles = products.map((product) => product.handle);
    if (new Set(handles).size !== handles.length) throw badRequest("Duplicate handles in import");
    const existing = await tx.product.findMany({ where: replace ? {} : { slug: { in: handles } }, select: { id: true, slug: true } });
    if (!replace && existing.length) throw conflict(`Existing handles: ${existing.slice(0, 10).map((product) => product.slug).join(", ")}. No products were imported.`);
    let removed = 0;
    if (replace) {
      const ids = existing.map((product) => product.id);
      await tx.cartItem.deleteMany({ where: { artworkId: { in: ids } } });
      await tx.wishlistItem.deleteMany({ where: { artworkId: { in: ids } } });
      await tx.recentView.deleteMany({ where: { artworkId: { in: ids } } });
      const collections = await tx.collection.findMany();
      const removedIds = new Set(ids);
      for (const collection of collections) {
        await tx.collection.update({ where: { slug: collection.slug }, data: { ids: collection.ids.filter((id) => !removedIds.has(id)) } });
      }
      removed = (await tx.product.deleteMany({ where: { id: { in: ids } } })).count;
    }
    const productRows: Prisma.ProductCreateManyInput[] = [];
    const variantRows: Prisma.ProductVariantCreateManyInput[] = [];
    const imageRows: Prisma.ProductImageCreateManyInput[] = [];
    const vendors = new Map<string, string>();
    for (const product of products) {
      const artistId = await productArtist(tx, product, vendors);
      const row = productData(product, artistId);
      productRows.push(row);
      variantRows.push(...product.variants.map((variant, sort) => ({
        ...variant, productId: row.id, unitPriceMeasure: json(variant.unitPriceMeasure), sort,
      })));
      imageRows.push(...product.images.map((image) => ({ ...image, productId: row.id })));
    }
    await tx.product.createMany({ data: productRows });
    await tx.productVariant.createMany({ data: variantRows });
    if (imageRows.length) await tx.productImage.createMany({ data: imageRows });
    const variants = variantRows.length;
    await audit(tx, actor, `Imported ${products.length} products / ${variants} variants; removed ${removed} old products`);
    return { created: products.length, variants, removed };
  }, { maxWait: 15000, timeout: 180000 });
}
