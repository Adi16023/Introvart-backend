import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Prisma, type Admin, type StaffSigningKey } from "@prisma/client";
import { buildApp } from "../src/app";
import { prisma } from "../src/lib/db";
import { artistRegistration } from "../src/services/artist-registration";
import { verifyPassword } from "../src/services/staff-auth";

const registration = {
  firstName: "Test", lastName: "Artist", email: "artist@example.test", phone: "+91 98765 43210",
  accountType: "Individual", password: "StudioPass1!", confirmPassword: "StudioPass1!",
};

test("artist registration validation", () => {
  const result = artistRegistration.parse({ ...registration, email: " ARTIST@EXAMPLE.TEST " });
  assert.equal(result.email, "artist@example.test");
  assert.equal(result.phone, "+919876543210");
  assert.deepEqual(result.portfolioLinks, []);
  for (const password of ["Short1!", "nouppercase1!", "NOLOWERCASE1!", "NoNumbers!!", "NoSpecial123", "A".repeat(129)]) {
    assert.equal(artistRegistration.safeParse({ ...registration, password, confirmPassword: password }).success, false, password);
  }
  for (const patch of [
    { confirmPassword: "Mismatch1!" }, { firstName: " " }, { lastName: "" }, { phone: "1234" },
    { websiteUrl: "javascript:alert(1)" }, { websiteUrl: "https://user:secret@example.test" },
    { behanceUrl: "https://behance.net.evil.test/artist" }, { portfolioLinks: [""] },
    { portfolioLinks: Array(6).fill("https://example.test") }, { gst: "29ABCDE1234F1Z5" },
    { role: "super" }, { creatorId: "someone-else" }, { accountType: "Other" },
  ]) assert.equal(artistRegistration.safeParse({ ...registration, ...patch }).success, false);
  assert.equal(artistRegistration.safeParse({ ...registration, password: "Aa1!abcd", confirmPassword: "Aa1!abcd" }).success, true);
  const business = artistRegistration.parse({
    ...registration, accountType: "Business", gst: "29abcde1234f1z5",
    websiteUrl: "https://example.test", behanceUrl: "https://www.behance.net/artist",
    portfolioLinks: ["https://example.test/work"],
  });
  assert.equal(business.gst, "29ABCDE1234F1Z5");
  assert.equal(artistRegistration.safeParse({ ...registration, accountType: "Business" }).success, true);
});

test("artist registration API creates an authenticated studio atomically", async t => {
  function stub(target: object, method: string, implementation: (...args: never[]) => unknown) {
    const original: unknown = Reflect.get(target, method);
    Object.defineProperty(target, method, { value: implementation, configurable: true, writable: true });
    t.after(() => Object.defineProperty(target, method, { value: original, configurable: true, writable: true }));
  }
  const artists = new Map<string, Prisma.ArtistUncheckedCreateInput>();
  const users = new Map<string, Admin>();
  let key: StaffSigningKey | null = null;
  let failAccount = false;
  let failSigning = false;
  stub(prisma.staffSigningKey, "findUnique", async () => {
    if (failSigning) throw new Error("Signing service unavailable (test)");
    return key;
  });
  stub(prisma.staffSigningKey, "upsert", async (args: { create: Omit<StaffSigningKey, "createdAt"> }) => {
    key ??= { ...args.create, createdAt: new Date() }; return key;
  });
  stub(prisma.admin, "findUnique", async (args: { where: { email?: string; id?: string } }) =>
    [...users.values()].find(user => user.email === args.where.email || user.id === args.where.id) ?? null);
  stub(prisma.admin, "findUniqueOrThrow", async (args: { where: { id: string } }) => {
    const user = users.get(args.where.id); assert.ok(user); return user;
  });
  stub(prisma.artist, "findUnique", async (args: { where: { id: string } }) => artists.get(args.where.id) ?? null);
  stub(prisma.artist, "create", async (args: { data: Prisma.ArtistUncheckedCreateInput }) => {
    artists.set(args.data.id, args.data); return args.data;
  });
  stub(prisma.admin, "create", async (args: { data: Pick<Admin, "email" | "name" | "role" | "passwordHash" | "creatorId"> }) => {
    if (failAccount) throw new Prisma.PrismaClientKnownRequestError("Duplicate email", { code: "P2002", clientVersion: "test", meta: { target: ["email"] } });
    const user: Admin = { ...args.data, id: `staff-${users.size}`, tokenVersion: 0, disabled: false, createdAt: new Date(), updatedAt: new Date() };
    users.set(user.id, user); return user;
  });
  stub(prisma, "$transaction", async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    const priorArtists = new Map(artists); const priorUsers = new Map(users);
    try { return await callback(prisma); }
    catch (error) {
      artists.clear(); users.clear();
      priorArtists.forEach((value, id) => artists.set(id, value));
      priorUsers.forEach((value, id) => users.set(id, value));
      throw error;
    }
  });
  const server = buildApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const register = (body: object, path = "/auth/artist/register") => fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  await t.test("returns creator session, hashes password, and preserves submitted fields", async () => {
    const response = await register({ ...registration, accountType: "Business", gst: "29ABCDE1234F1Z5", websiteUrl: "https://example.test", behanceUrl: "https://behance.net/test", portfolioLinks: ["https://example.test/work"] });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const session = await response.json();
    assert.equal(session.user.role, "creator");
    assert.equal(session.tokenType, "Bearer");
    assert.equal(session.expiresIn, 3600);
    assert.equal("passwordHash" in session.user, false);
    assert.equal("password" in session, false);
    const user = users.get(session.user.id); assert.ok(user);
    assert.equal(await verifyPassword(registration.password, user.passwordHash), true);
    const artist = artists.get(session.user.creatorId); assert.ok(artist);
    assert.equal(artist.firstName, "Test");
    assert.equal(artist.lastName, "Artist");
    assert.equal(artist.phone, "+919876543210");
    assert.equal(artist.gst, "29ABCDE1234F1Z5");
    assert.equal(artist.websiteUrl, "https://example.test");
    assert.equal(artist.behanceUrl, "https://behance.net/test");
    assert.deepEqual(artist.portfolioLinks, ["https://example.test/work"]);
    const headers = { Authorization: `Bearer ${session.accessToken}` };
    assert.equal((await fetch(`${base}/auth/me`, { headers })).status, 200);
    const studio = await fetch(`${base}/creator/me`, { headers });
    assert.equal(studio.status, 200);
    assert.equal((await studio.json()).id, artist.id);
    assert.equal((await fetch(`${base}/admin/me`, { headers })).status, 401);
  });
  await t.test("duplicate email and privilege injection create no extra studio", async () => {
    assert.equal((await register({ ...registration, email: " ARTIST@example.test " })).status, 409);
    assert.equal((await register({ ...registration, email: "injection@example.test", role: "super" })).status, 400);
    assert.equal(artists.size, 1); assert.equal(users.size, 1);
  });
  await t.test("account uniqueness race rolls back the artist", async () => {
    failAccount = true;
    assert.equal((await register({ ...registration, email: "race@example.test" })).status, 409);
    failAccount = false;
    assert.equal(artists.size, 1); assert.equal(users.size, 1);
  });
  await t.test("token issuance failure rolls back both account and studio", async () => {
    failSigning = true;
    assert.equal((await register({ ...registration, email: "signing@example.test" })).status, 500);
    failSigning = false;
    assert.equal(artists.size, 1); assert.equal(users.size, 1);
  });
  await t.test("legacy endpoint cannot create passwordless orphan studios", async () => {
    assert.equal((await register({ name: "Old Studio", email: "old@example.test", phone: "9876543210" }, "/creator/register")).status, 400);
    assert.equal((await register({ ...registration, email: "second@example.test" }, "/creator/register")).status, 201);
    assert.equal(artists.size, 2); assert.equal(users.size, 2);
    assert.equal(new Set([...artists.values()].map(artist => artist.slug)).size, 2);
  });
  await t.test("registration and its legacy alias share rate limiting", async () => {
    let status = 0;
    for (let attempt = 0; attempt < 11 && status !== 429; attempt++) {
      status = (await register({}, attempt % 2 ? "/creator/register" : "/auth/artist/register")).status;
    }
    assert.equal(status, 429);
    assert.equal(artists.size, 2);
  });
});
