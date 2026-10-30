import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { readProductCsv, csvSummary } from "../src/services/product-csv";
import { productSchema, plainDescription } from "../src/services/products";
import { selectedVariant, variantAvailable } from "../src/services/product-variants";
import { loadPricedCart } from "../src/services/cart";
import { fromPrice, unitPrice, type PricingConfig } from "../src/services/pricing";
import { prisma } from "../src/lib/db";
import type { ProductVariant } from "@prisma/client";

const csv = [
  "Handle,Title,Body (HTML),Vendor,Published,Option1 Name,Option1 Value,Variant Price,Variant Inventory Tracker,Variant Inventory Qty,Variant Inventory Policy,Image Src,Image Position,SEO Title,Status",
  'test-print,Test Print,"<p>A print, with colour</p>",Test Studio,true,Size,A4,109.50,,0,deny,https://example.test/a.jpg,1,SEO print,active',
  'test-print,,,,,,A5,79.00,,-2,deny,https://example.test/b.jpg,2,,',
].join("\r\n");
const config: PricingConfig = {
  taxRate: 0.12, freeShippingOver: 2999, standardShipping: 149, expressShipping: 349, codLimit: 5000,
  personalizationFee: 250, sizes: [{ id: "a3", label: "A3", cm: "", price: 799 }],
  materials: [{ id: "matte", label: "Matte", multiplier: 1 }],
  frames: [{ id: "none", label: "None", price: 0, swatch: "" }],
};

test("groups repeated handles into products with independently priced variants and images", () => {
  const parsed = readProductCsv(`\uFEFF${csv}`);
  assert.deepEqual(parsed.errors, []);
  const summary = csvSummary(parsed);
  assert.equal(summary.products, 1);
  assert.equal(summary.variants, 2);
  assert.equal(summary.images, 2);
  const product = parsed.products[0];
  assert.equal(product.descriptionHtml, "<p>A print, with colour</p>");
  assert.equal(product.variants[0].price, 109.5);
  assert.equal(product.variants[1].inventoryQuantity, -2);
  assert.equal(product.images[1].position, 2);
  assert.equal(product.seoTitle, "SEO print");
  assert.equal(product.sourceRows[1]["Variant Price"], "79.00");
  assert.equal(product.sourceRows[1].Title, "");
  assert.equal(fromPrice(config, { fulfilment: "platform_pod", basePrice: 0, priceFactor: 1, variants: product.variants }), 79);
});

test("handles quoted newlines, quotes, image-only rows and arbitrary preserved columns", () => {
  const input = 'Handle,Title,Body (HTML),Variant Price,Image Src,Image Position,Extra\r\nprint,"Quoted ""title""","line one\nline two",100,https://example.test/a.jpg,1,value\r\nprint,,,,https://example.test/b.jpg,2,other';
  const parsed = readProductCsv(input);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.products[0].title, 'Quoted "title"');
  assert.equal(parsed.products[0].sourceRows[1].Extra, "other");
  assert.equal(parsed.products[0].images.length, 2);
  assert.equal(parsed.products[0].variants.length, 1);
});

test("rejects malformed, missing-header and duplicate-header CSV", () => {
  assert.throws(() => readProductCsv("Title,Price\nPrint,5"), /Missing CSV column/);
  assert.throws(() => readProductCsv('Handle,Title,Variant Price,Image Src\n"unterminated'), /Invalid CSV/);
  assert.throws(() => readProductCsv("Handle,Handle,Title,Variant Price,Image Src\nx,x,x,1,"), /Duplicate CSV column/);
});

test("reports invalid prices, booleans, URLs, duplicate variants and missing variant prices", () => {
  for (const input of [
    csv.replace("109.50", "-1"),
    csv.replace("109.50", "109.999"),
    csv.replace("true,Size", "yes,Size"),
    csv.replace("https://example.test/a.jpg", "javascript:alert(1)"),
    csv.replace(",,A5,79", ",,A4,79"),
    csv.replace("A4,109.50", "A4,"),
  ]) {
    assert.ok(readProductCsv(input).errors.length, input);
  }
});

test("draft products may have no image; published active products require an image", () => {
  const input = { handle: "draft", title: "Draft", images: [], variants: [{ price: 1 }] };
  assert.equal(productSchema.safeParse(input).success, true);
  assert.equal(productSchema.safeParse({ ...input, catalogStatus: "active" }).success, false);
  assert.equal(productSchema.safeParse({ ...input, catalogStatus: "active", published: false }).success, true);
});

test("plain description does not expose executable markup", () => {
  assert.equal(plainDescription('<script>alert(1)</script><style>body{}</style><p>Hello &amp; welcome</p>'), "Hello & welcome");
});

test("inventory respects blank trackers, deny and continue policies", () => {
  assert.equal(variantAvailable({ inventoryTracker: "", inventoryPolicy: "deny", inventoryQuantity: -2 }), true);
  assert.equal(variantAvailable({ inventoryTracker: "shopify", inventoryPolicy: "deny", inventoryQuantity: 0 }), false);
  assert.equal(variantAvailable({ inventoryTracker: "shopify", inventoryPolicy: "continue", inventoryQuantity: 0 }, 3), true);
  assert.equal(variantAvailable({ inventoryTracker: "shopify", inventoryPolicy: "deny", inventoryQuantity: 2 }, 3), false);
  assert.equal(selectedVariant([], undefined), null);
  assert.throws(() => selectedVariant([], "forged"), /no variants/);
});

test("cart uses authoritative variant prices, rejects stale variants and preserves legacy pricing", async (t) => {
  function stub(target: object, method: string, implementation: () => Promise<unknown>) {
    const original: unknown = Reflect.get(target, method);
    Object.defineProperty(target, method, { value: implementation, configurable: true, writable: true });
    t.after(() => Object.defineProperty(target, method, { value: original, configurable: true, writable: true }));
  }
  const variant: ProductVariant = {
    id: "v1", productId: "p1", optionValues: ["A4"], sku: "PRINT-A4", barcode: "", price: 109.5, compareAtPrice: null,
    inventoryTracker: "", inventoryQuantity: 0, inventoryPolicy: "deny", fulfillmentService: "manual", requiresShipping: true,
    taxable: true, grams: 0, weightUnit: "kg", image: "", taxCode: "", costPerItem: null, unitPriceMeasure: {},
    packedLength: null, packedWidth: null, packedHeight: null, packedDimensionUnit: "", sort: 0,
  };
  const base = { id: "p1", slug: "print", stock: null, status: "approved", artistId: "vendor", fulfilment: "platform_pod", basePrice: 0, priceFactor: 1, personalization: null, variants: [variant] };
  stub(prisma.product, "findMany", async () => [base]);
  const cartItem = { id: "cart-test", ownerId: "test", artworkId: "p1", variantId: "v1", title: "Print", artistName: "Studio", image: "",
    fulfilment: "platform_pod", sizeId: "a3", materialId: "matte", frameId: "none", quantity: 2,
    personalization: null, note: null, gift: false, giftMessage: "", createdAt: new Date() };
  stub(prisma.cartItem, "findMany", async () => [cartItem]);
  let priced = await loadPricedCart(prisma, "test", config);
  assert.equal(priced.subtotal, 219);
  assert.equal(priced.lines[0].variantTitle, "A4");
  assert.equal(priced.lines[0].problem, null);
  variant.price = 109.1;
  assert.equal((await loadPricedCart(prisma, "test", config)).subtotal, 218.2);
  variant.inventoryTracker = "shopify";
  priced = await loadPricedCart(prisma, "test", config);
  assert.match(priced.lines[0].problem || "", /insufficient stock/);
  cartItem.variantId = "forged";
  priced = await loadPricedCart(prisma, "test", config);
  assert.match(priced.lines[0].problem || "", /valid variant/);
  assert.equal(unitPrice(config, { fulfilment: "platform_pod", basePrice: 0, priceFactor: 1, sizeId: "a3", materialId: "matte", frameId: "none" }), 799);
});

test("supplied export has exactly 50 products, 196 variants and 68 preserved columns", { skip: !process.env.PRODUCT_CSV_TEST_FILE }, async () => {
  const parsed = readProductCsv(await readFile(process.env.PRODUCT_CSV_TEST_FILE!, "utf8"));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.products.length, 50);
  assert.equal(parsed.headers.length, 68);
  assert.equal(parsed.products.reduce((count, product) => count + product.variants.length, 0), 196);
  for (const product of parsed.products) {
    for (const row of product.sourceRows) assert.equal(Object.keys(row).length, 68);
  }
});
