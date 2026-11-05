import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type { Admin, StaffSigningKey } from "@prisma/client";
import { buildApp } from "../src/app";
import { prisma } from "../src/lib/db";
import { defaultHomepage, homepageSchema, saveHomepage, type HomepageDocument } from "../src/services/homepage";
import { invalidateStorefrontHome, loadHomepageContent, loadStorefrontHome } from "../src/services/storefront";
import { issueStaffToken } from "../src/services/staff-auth";

const banners = [
  { id: "banner", eyebrow: "Welcome", title: "Original", subtitle: "Original copy", href: "/shop", image: "/original.jpg" },
  { id: "legacy", eyebrow: "", title: "Legacy banner", subtitle: "", href: "/gift-cards", image: "https://legacy.example.test/banner.jpg" },
];

test("homepage validation rejects unsafe links, duplicate identifiers and out-of-range settings", () => {
  const config = defaultHomepage(banners);
  assert.ok(homepageSchema.safeParse(config).success);
  for (const href of ["javascript:alert(1)", "//outside.test", "/\\outside.test", "http://outside.test", "/shop\ninjected"]) {
    const invalid = structuredClone(config);
    invalid.sections[0].cards[0].href = href;
    assert.equal(homepageSchema.safeParse(invalid).success, false, href);
  }
  for (const change of [{ limit: 25 }, { limit: 0 }, { columns: 5 }, { spacing: -1 }, { background: "red" }]) {
    const invalid = structuredClone(config);
    Object.assign(invalid.sections[0], change);
    assert.equal(homepageSchema.safeParse(invalid).success, false);
  }
  assert.equal(homepageSchema.safeParse({ ...config, sections: [config.sections[0], config.sections[0]] }).success, false);
  const invalid = structuredClone(config);
  invalid.sections[0].cards.push(invalid.sections[0].cards[0]);
  assert.equal(homepageSchema.safeParse(invalid).success, false);
});

test("homepage drafts, publishing, permissions, cache invalidation and curated content", async (t) => {
  function stub(target: object, method: string, implementation: (...args: never[]) => unknown) {
    const original: unknown = Reflect.get(target, method);
    Object.defineProperty(target, method, { value: implementation, configurable: true, writable: true });
    t.after(() => Object.defineProperty(target, method, { value: original, configurable: true, writable: true }));
  }
  let row: { key: string; data: HomepageDocument } | null = null;
  let delayedRead: { started: () => void; wait: Promise<void> } | null = null;
  const config = {
    taxRate: 0.12, freeShippingOver: 2999, standardShipping: 149, expressShipping: 349, codLimit: 5000,
    personalizationFee: 250, sizes: [{ id: "a3", label: "A3", cm: "", price: 799 }],
    materials: [{ id: "matte", label: "Matte", multiplier: 1 }],
    frames: [{ id: "none", label: "None", price: 0, swatch: "" }],
    colours: ["Blue"], rooms: [], partnerName: "Test", capacity: 100, holidays: "",
  };
  let key: StaffSigningKey | null = null;
  let user: Admin = {
    id: "homepage-test", email: "homepage@example.test", name: "Homepage Editor", passwordHash: "",
    role: "marketing", creatorId: null, disabled: false, tokenVersion: 0, createdAt: new Date(), updatedAt: new Date(),
  };
  stub(prisma.staffSigningKey, "findUnique", async () => key);
  stub(prisma.staffSigningKey, "upsert", async (args: { create: Omit<StaffSigningKey, "createdAt"> }) => {
    key ??= { ...args.create, createdAt: new Date() };
    return key;
  });
  stub(prisma.admin, "findUnique", async () => user);
  stub(prisma.siteSetting, "findUnique", async (args: { where: { key: string } }) => {
    if (args.where.key !== "homepage") return null;
    if (delayedRead) {
      const snapshot = structuredClone(row);
      const delay = delayedRead;
      delayedRead = null;
      delay.started();
      await delay.wait;
      return snapshot;
    }
    return row;
  });
  stub(prisma.siteSetting, "create", async (args: { data: { key: string; data: HomepageDocument } }) => { row = structuredClone(args.data); return row; });
  let simulateConcurrentSave = false;
  stub(prisma.siteSetting, "updateMany", async (args: { where: { data: { equals: number } }; data: { data: HomepageDocument } }) => {
    if (simulateConcurrentSave || row?.data.revision !== args.where.data.equals) return { count: 0 };
    row.data = structuredClone(args.data.data);
    return { count: 1 };
  });
  stub(prisma.config, "findUnique", async () => config);
  stub(prisma.banner, "findMany", async () => banners);
  stub(prisma.collection, "findMany", async () => []);
  stub(prisma.collection, "findUnique", async () => ({ ids: ["p2", "p1"] }));
  stub(prisma.occasion, "findMany", async () => []);
  stub(prisma.menuConfig, "findUnique", async () => null);
  stub(prisma.activity, "create", async () => ({}));
  const product = (id: string) => ({
    id, slug: id, title: id, image: "/art.jpg", images: [], fulfilment: "platform_pod", basePrice: 0, priceFactor: 1,
    stock: null, rating: 0, reviewCount: 0, artist: { id: "a1", name: "Artist" }, variants: [{ price: 100 }],
  });
  stub(prisma.product, "findMany", async (args: { where: { status: string; artist: { suspended: boolean }; id?: { in: string[] } }; take?: number }) => {
    assert.equal(args.where.status, "approved");
    assert.equal(args.where.artist.suspended, false);
    return ["p1", "p2"].filter((id) => !args.where.id || args.where.id.in.includes(id)).slice(0, args.take ?? 24).map(product);
  });
  stub(prisma.artist, "findMany", async (args: { where: { verified: boolean; suspended: boolean } }) => {
    assert.equal(args.where.verified, true); assert.equal(args.where.suspended, false);
    return [{ id: "a1", slug: "artist", name: "Artist", city: "City", portrait: "/artist.jpg" }];
  });
  invalidateStorefrontHome();
  const server = buildApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    invalidateStorefrontHome();
    await prisma.$disconnect();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  let token = (await issueStaffToken(user)).accessToken;
  const call = (path: string, method = "GET", body?: unknown, auth = true) => fetch(`${base}${path}`, {
    method, headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await call("/admin/cms/homepage", "GET", undefined, false)).status, 401);
  const initialResponse = await call("/admin/cms/homepage");
  assert.equal(initialResponse.headers.get("cache-control"), "private, no-store");
  const initial: HomepageDocument = await initialResponse.json();
  assert.equal(initial.revision, 0);
  assert.equal(initial.publishedAt, null);
  assert.deepEqual(initial.draft, initial.published);
  const firstHome = await call("/storefront/home", "GET", undefined, false).then((response) => response.json());
  assert.equal(firstHome.homepage.sections[0].cards[0].title, "Original");

  const draft = structuredClone(initial.draft);
  draft.sections[0].cards[0].title = "Custom print, your way";
  draft.sections[0].cards[0].image = "/new-banner.jpg";
  draft.sections[0].cards[0].showText = true;
  draft.sections.reverse();
  const savedResponse = await call("/admin/cms/homepage/draft", "PUT", { revision: 0, config: draft });
  assert.equal(savedResponse.status, 200);
  const saved: HomepageDocument = await savedResponse.json();
  assert.equal(saved.revision, 1);
  assert.equal(saved.publishedAt, null);
  assert.deepEqual(saved.draft, draft);
  assert.deepEqual(saved.published, initial.published);
  const reloaded: HomepageDocument = await call("/admin/cms/homepage").then((response) => response.json());
  assert.deepEqual(reloaded.draft, draft);
  const unchanged = await call("/storefront/home", "GET", undefined, false).then((response) => response.json());
  assert.deepEqual(unchanged.homepage, initial.published);
  assert.equal((await call("/admin/cms/homepage/draft", "PUT", { revision: 0, config: draft })).status, 409);

  simulateConcurrentSave = true;
  assert.equal((await call("/admin/cms/homepage/draft", "PUT", { revision: 1, config: draft })).status, 409);
  simulateConcurrentSave = false;
  const publishedResponse = await call("/admin/cms/homepage/publish", "PUT", { revision: 1, config: draft });
  assert.equal(publishedResponse.status, 200);
  const published: HomepageDocument = await publishedResponse.json();
  assert.equal(published.revision, 2);
  assert.ok(published.publishedAt);
  const live = await call("/storefront/home", "GET", undefined, false).then((response) => response.json());
  assert.deepEqual(live.homepage, draft);
  assert.equal(live.draft, undefined);
  assert.equal(live.revision, undefined);

  const curated = structuredClone(draft);
  const rail = curated.sections.find((section) => section.type === "products")!;
  rail.source = "selected"; rail.selection = ["p2", "unavailable", "p1"]; rail.limit = 2;
  const artistSection = curated.sections.find((section) => section.type === "artists")!;
  artistSection.selection = ["unavailable", "a1"];
  const previewResponse = await call("/admin/cms/homepage/preview", "POST", curated);
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers.get("cache-control"), "private, no-store");
  const preview = await previewResponse.json();
  assert.deepEqual(preview.sectionProducts[rail.id].map((item: { id: string }) => item.id), ["p2", "p1"]);
  assert.deepEqual(preview.sectionArtists[artistSection.id].map((item: { id: string }) => item.id), ["a1"]);
  rail.source = "collection"; rail.collectionSlug = "test";
  assert.deepEqual((await loadHomepageContent(curated)).sectionProducts[rail.id].map((item) => item.id), ["p2", "p1"]);
  assert.deepEqual((await call("/admin/cms/homepage").then((response) => response.json())).draft, draft, "Preview never saves");
  const unsafe = structuredClone(draft);
  unsafe.sections[0].href = "javascript:alert(1)";
  assert.equal((await call("/admin/cms/homepage/publish", "PUT", { revision: 2, config: unsafe })).status, 400);
  const externalImage = structuredClone(draft);
  externalImage.sections.find((section) => section.type === "hero")!.cards[0].image = "https://outside.test/track.jpg";
  assert.equal((await call("/admin/cms/homepage/draft", "PUT", { revision: 2, config: externalImage })).status, 400);
  assert.deepEqual((await call("/admin/cms/homepage").then((response) => response.json())).published, draft);
  user = { ...user, role: "support" };
  token = (await issueStaffToken(user)).accessToken;
  for (const [path, method, body] of [
    ["/admin/cms/homepage", "GET", undefined],
    ["/admin/cms/homepage/draft", "PUT", { revision: 2, config: draft }],
    ["/admin/cms/homepage/publish", "PUT", { revision: 2, config: draft }],
    ["/admin/cms/homepage/preview", "POST", draft],
  ] as const) assert.equal((await call(path, method, body)).status, 403);

  await t.test("a stale in-flight build cannot overwrite a freshly published homepage cache", async () => {
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    delayedRead = { started, wait };
    invalidateStorefrontHome();
    const staleBuild = loadStorefrontHome();
    await reading;
    const next = structuredClone(draft);
    next.sections[0].title = "Latest published heading";
    await saveHomepage(next, 2, true);
    invalidateStorefrontHome();
    const fresh = await loadStorefrontHome();
    assert.deepEqual(fresh.homepage, next);
    release();
    assert.deepEqual((await staleBuild).homepage, draft);
    assert.deepEqual((await loadStorefrontHome()).homepage, next);
  });
});
