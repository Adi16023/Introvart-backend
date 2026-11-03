import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { Prisma } from "@prisma/client";
import { buildApp } from "../src/app";
import { prisma } from "../src/lib/db";

test("focused storefront endpoints, public caching and private isolation", async (t) => {
  function stub(target: object, method: string, implementation: (...args: never[]) => unknown) {
    const original: unknown = Reflect.get(target, method);
    Object.defineProperty(target, method, { value: implementation, configurable: true, writable: true });
    t.after(() => Object.defineProperty(target, method, { value: original, configurable: true, writable: true }));
  }
  let now = Date.now();
  stub(Date, "now", () => now);
  const config = {
    taxRate: 0.12, freeShippingOver: 2999, standardShipping: 149, expressShipping: 349, codLimit: 5000,
    personalizationFee: 250, sizes: [{ id: "a3", label: "A3", cm: "", price: 799 }],
    materials: [{ id: "matte", label: "Matte", multiplier: 1 }],
    frames: [{ id: "none", label: "None", price: 0, swatch: "" }],
    colours: ["Blue"], rooms: ["Living room", "Office"], partnerName: "Test", capacity: 100, holidays: "",
  };
  let builds = 0;
  let failProducts = false;
  const queries: Prisma.ProductFindManyArgs[] = [];
  stub(prisma.config, "findUnique", async () => config);
  stub(prisma.banner, "findMany", async (args: Prisma.BannerFindManyArgs) => {
    builds += 1;
    assert.equal(args.take, 3);
    return [];
  });
  stub(prisma.collection, "findMany", async (args: Prisma.CollectionFindManyArgs) => {
    assert.equal(args.select?.ids, undefined);
    return [];
  });
  stub(prisma.occasion, "findMany", async () => []);
  stub(prisma.artist, "findMany", async (args: Prisma.ArtistFindManyArgs) => {
    assert.equal(args.take, 6);
    assert.equal(args.select?.email, undefined);
    assert.equal(args.select?.bank, undefined);
    return [];
  });
  stub(prisma.product, "findMany", async (args: Prisma.ProductFindManyArgs) => {
    queries.push(args);
    if (failProducts) throw new Error("Test database failure");
    assert.equal(args.select?.story, undefined);
    assert.equal(args.select?.descriptionHtml, undefined);
    assert.equal(args.select?.sourceRows, undefined);
    assert.deepEqual(args.select?.variants, { select: { price: true }, orderBy: { price: "asc" }, take: 1 });
    return [{
      id: "p1", slug: "print", title: "Print", image: "https://example.test/print.jpg",
      images: [1, 2, 3].map((position) => ({ src: `https://example.test/${position}.jpg`, position, alt: "" })),
      fulfilment: "platform_pod", basePrice: 0, priceFactor: 1, stock: null, rating: 4.8, reviewCount: 20,
      artist: { id: "a1", name: "Test Artist" }, variants: [{ price: 120 }, { price: 99 }],
    }];
  });
  stub(prisma.menuConfig, "findUnique", async () => null);
  stub(prisma.siteSetting, "findUnique", async () => null);
  stub(prisma, "$queryRaw", async () => [{ name: "Living room", count: 250, image: "https://example.test/room.jpg" }]);
  stub(prisma.cartItem, "aggregate", async (args: { where: { ownerId: string } }) => ({ _sum: { quantity: args.where.ownerId === "customer-1" ? 5 : 2 } }));
  stub(prisma.wishlistItem, "findMany", async (args: { where: { ownerId: string } }) => [{ productId: `${args.where.ownerId}-wish` }]);
  stub(prisma.follow, "findMany", async () => [{ artistId: "a1" }]);
  stub(prisma.recentView, "findMany", async () => [{ productId: "p1" }]);
  stub(prisma.searchHistory, "findMany", async () => [{ query: "blue" }, { query: "blue" }, { query: "art" }]);
  stub(prisma.customer, "findUnique", async (args: { where: { id: string }; select: Prisma.CustomerSelect }) => {
    assert.equal(args.select.addresses, undefined);
    return { id: args.where.id, name: "Customer", email: "", phone: "", city: "", credit: 0, risk: null, referral: "" };
  });
  for (const table of [prisma.order, prisma.saved, prisma.commission, prisma.returns]) {
    stub(table, "findMany", async () => { throw new Error("Homepage must not load account data"); });
  }
  const server = buildApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1`;

  await t.test("concurrent public requests share one bounded build, regardless of visitor", async () => {
    const responses = await Promise.all([
      fetch(`${base}/storefront/home`),
      fetch(`${base}/storefront/home`, { headers: { "x-customer-id": "customer-1" } }),
    ]);
    const [home, other] = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(home, other);
    assert.equal(builds, 1);
    assert.equal(queries.length, 2);
    assert.ok(queries.every((query) => query.take === 8 && query.where?.status === "approved"));
    assert.equal(home.trending[0].fromPrice, 99);
    assert.equal(home.trending[0].images.length, 2);
    assert.equal(home.trending[0].variants, undefined);
    assert.equal(home.customer, undefined);
    assert.equal(home.config.capacity, undefined);
    assert.deepEqual(home.roomHighlights.map((room: { count: number }) => room.count), [250, 0]);
    assert.ok(home.menu.tabs.length);
    assert.ok(home.searchSettings.placeholders.length);
    assert.match(responses[0].headers.get("cache-control") ?? "", /^public/);
    await fetch(`${base}/storefront/home`);
    assert.equal(builds, 1);
  });

  await t.test("session responses require identity, stay private and never share visitor data", async () => {
    assert.equal((await fetch(`${base}/storefront/session`)).status, 400);
    const guest = await fetch(`${base}/storefront/session`, { headers: { "x-guest-id": "visitor" } });
    const guestBody = await guest.json();
    assert.equal(guest.headers.get("cache-control"), "private, no-store");
    assert.equal(guestBody.customer, null);
    assert.equal(guestBody.cartCount, 2);
    assert.deepEqual(guestBody.wishlist, ["guest:visitor-wish"]);
    assert.equal(guestBody.recent[0].id, "p1");
    assert.deepEqual(guestBody.recentSearches, ["blue", "art"]);
    const customer = await fetch(`${base}/storefront/session`, { headers: { "x-customer-id": "customer-1" } }).then((response) => response.json());
    assert.equal(customer.customer.id, "customer-1");
    assert.equal(customer.cartCount, 5);
    assert.deepEqual(customer.wishlist, ["customer-1-wish"]);
    assert.equal(customer.orders, undefined);
    assert.equal(customer.addresses, undefined);
  });

  await t.test("expired builds are refreshed; failures are explicit and retryable", async () => {
    now += 60_001;
    failProducts = true;
    assert.equal((await fetch(`${base}/storefront/home`)).status, 500);
    failProducts = false;
    const response = await fetch(`${base}/storefront/home`);
    assert.equal(response.status, 200);
    assert.equal(builds, 3);
  });
});
