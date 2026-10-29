import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { buildApp } from "../src/app";
import { prisma } from "../src/lib/db";
import { issueStaffToken } from "../src/services/staff-auth";
import { readProductCsv } from "../src/services/product-csv";
import { productInclude } from "../src/services/products";
import type { Artwork, ProductVariant } from "@prisma/client";

after(() => prisma.$disconnect());

test("product API, CSV import and variant checkout against configured database", { skip: process.env.RUN_PRODUCT_DB_TESTS !== "1" }, async (t) => {
  const suffix = randomUUID().replace(/-/g, "");
  const handle = `integration-product-${suffix}`;
  const bulkHandle = `integration-bulk-${suffix}`;
  const ownerId = `guest:product-test-${suffix}`;
  const guest = { "x-guest-id": `product-test-${suffix}` };
  const existing = await prisma.artwork.findFirstOrThrow({ where: { status: "approved" }, include: { artist: true } });
  const user = await prisma.staffUser.findFirstOrThrow({ where: { role: "super", disabled: false } });
  const token = (await issueStaffToken(user)).accessToken;
  const headers = { Authorization: `Bearer ${token}` };
  const server = buildApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const call = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
  const send = (path: string, body: unknown, auth: Record<string, string> = headers) => call(path, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  t.after(async () => {
    try {
      await prisma.cartItem.deleteMany({ where: { ownerId } });
      await prisma.order.deleteMany({ where: { ownerId } });
      await prisma.artwork.deleteMany({ where: { slug: { in: [handle, bulkHandle] } } });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  let created: Artwork & { variants: ProductVariant[] };
  await t.test("add-product API validates requests and persists variants and images", async () => {
    const invalid = await send("/admin/products", { title: "Invalid" });
    assert.equal(invalid.status, 400);
    const response = await send("/admin/products", {
      handle, title: "Integration product", artistId: existing.artistId, vendor: existing.vendor,
      catalogStatus: "active", published: true, options: [{ name: "Size" }],
      images: [{ src: existing.image, position: 1, alt: "Test" }],
      variants: [
        { optionValues: ["A4"], sku: `${suffix}-A4`, price: 109.5, inventoryTracker: "shopify", inventoryQuantity: 2 },
        { optionValues: ["A5"], price: 79, inventoryQuantity: -2 },
      ],
    });
    assert.equal(response.status, 201, await response.clone().text());
    created = await response.json();
    assert.equal(created.variants.length, 2);
    assert.equal(created.variants[0].price, 109.5);
    assert.equal((await prisma.productImage.count({ where: { productId: created.id } })), 1);
    assert.equal((await send("/admin/products", {
      handle, title: "Duplicate", images: [], variants: [{ price: 1 }],
    })).status, 409);
  });
  await t.test("public product aliases expose exact variant pricing and preserve artwork links", async () => {
    for (const prefix of ["products", "artworks"]) {
      const response = await call(`/${prefix}/${handle}`);
      assert.equal(response.status, 200);
      const product = await response.json();
      assert.equal(product.fromPrice, 79);
      assert.equal(product.variants[0].price, 109.5);
      assert.equal(product.productOptions[0].name, "Size");
      assert.equal("sourceRows" in product, false);
    }
    const quote = await send("/pricing/quote", { artworkId: created.id, variantId: created.variants[0].id, quantity: 2 }, guest);
    assert.equal(quote.status, 200);
    assert.equal((await quote.json()).total, 219);
    assert.equal((await send("/pricing/quote", { artworkId: created.id }, guest)).status, 400);
  });
  await t.test("cart and checkout reserve the selected SKU and release inventory on cancellation", async () => {
    const body = { artworkId: created.id, variantId: created.variants[0].id, quantity: 2 };
    assert.equal((await send("/cart/items", { ...body, variantId: "forged" }, guest)).status, 400);
    assert.equal((await send("/cart/items", { artworkId: created.id }, guest)).status, 400);
    const added = await send("/cart/items", body, guest);
    assert.equal(added.status, 201, await added.clone().text());
    assert.equal((await send("/cart/items", { ...body, quantity: 1 }, guest)).status, 409);
    const cart = await (await call("/cart", { headers: guest })).json();
    assert.equal(cart.items[0].unitPrice, 109.5);
    assert.equal(cart.subtotal, 219);
    const response = await send("/orders", {
      address: { name: "Integration test", phone: "9999999999", line: "Test address", city: "Bengaluru", state: "Karnataka", pincode: "560038" },
      delivery: "standard", paymentMethod: "cod", email: "integration@example.test", name: "Integration test",
    }, guest);
    assert.equal(response.status, 201, await response.clone().text());
    const order = await response.json();
    assert.equal(order.items[0].unitPrice, 109.5);
    assert.equal(order.items[0].sizeLabel, "A4");
    assert.equal(order.items[0].sku, `${suffix}-A4`);
    assert.equal(order.items[0].variantId, created.variants[0].id);
    assert.equal(order.subtotal, 219);
    assert.equal((await prisma.productVariant.findUniqueOrThrow({ where: { id: created.variants[0].id } })).inventoryQuantity, 0);
    assert.equal((await send("/cart/items", { ...body, quantity: 1 }, guest)).status, 409);
    const cancelled = await send(`/me/orders/${order.id}/cancel`, {}, guest);
    assert.equal(cancelled.status, 200, await cancelled.clone().text());
    assert.equal((await prisma.productVariant.findUniqueOrThrow({ where: { id: created.variants[0].id } })).inventoryQuantity, 2);
  });
  await t.test("CSV preview is read-only, commit works and re-imports do not change existing products", async () => {
    const csv = `Handle,Title,Vendor,Variant Price,Image Src,Status\n${bulkHandle},Integration bulk,${existing.vendor},199,${existing.image},draft`;
    const upload = (preview: boolean, content = csv) => {
      const body = new FormData();
      body.set("file", new Blob([content], { type: "text/csv" }), "products.csv");
      return call(`/admin/products/import?preview=${preview}`, { method: "POST", headers, body });
    };
    const preview = await upload(true);
    assert.equal(preview.status, 200, await preview.clone().text());
    assert.equal((await preview.json()).errors.length, 0);
    assert.equal(await prisma.artwork.count({ where: { slug: bulkHandle } }), 0);
    const invalid = await upload(false, csv.replace(",199,", ",-1,"));
    assert.equal(invalid.status, 400);
    assert.equal(await prisma.artwork.count({ where: { slug: bulkHandle } }), 0);
    const imported = await upload(false);
    assert.equal(imported.status, 201, await imported.clone().text());
    assert.equal((await imported.json()).created, 1);
    const bulk = await prisma.artwork.findUniqueOrThrow({ where: { slug: bulkHandle }, include: productInclude });
    assert.equal(bulk.variants[0].price, 199);
    assert.equal(bulk.status, "draft");
    assert.equal((await upload(false)).status, 400);
    assert.equal(await prisma.artwork.count({ where: { slug: bulkHandle } }), 1);
  });
});

test("stored replacement matches every supplied CSV product, variant and original column", { skip: !process.env.PRODUCT_CSV_TEST_FILE || process.env.RUN_PRODUCT_DB_TESTS !== "1" }, async () => {
  const parsed = readProductCsv(await readFile(process.env.PRODUCT_CSV_TEST_FILE!, "utf8"));
  const stored = await prisma.artwork.findMany({ where: { slug: { in: parsed.products.map((product) => product.handle) } }, include: productInclude });
  assert.equal(stored.length, 50);
  assert.equal(stored.reduce((sum, product) => sum + product.variants.length, 0), 196);
  for (const input of parsed.products) {
    const product = stored.find((entry) => entry.slug === input.handle);
    assert.ok(product);
    assert.deepEqual(product.sourceRows, input.sourceRows);
    assert.equal(product.descriptionHtml, input.descriptionHtml);
    assert.equal(product.vendor, input.vendor);
    assert.deepEqual(product.options, input.options);
    assert.equal(product.seoTitle, input.seoTitle);
    assert.deepEqual(product.metafields, input.metafields);
    assert.deepEqual(product.googleShopping, input.googleShopping);
    assert.equal(product.catalogStatus, input.catalogStatus);
    assert.equal(product.status, input.published && input.catalogStatus === "active" ? "approved" : "draft");
    for (const [index, variant] of product.variants.entries()) {
      const { id: _id, productId: _productId, sort: _sort, ...fields } = variant;
      assert.deepEqual(fields, input.variants[index]);
    }
    assert.deepEqual(product.images.map(({ id: _id, productId: _productId, ...image }) => image), [...input.images].sort((a, b) => a.position - b.position));
  }
});
