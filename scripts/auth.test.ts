import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import type { StaffSigningKey, StaffUser } from "@prisma/client";
import { buildApp } from "../src/app";
import { prisma } from "../src/lib/db";
import { hashPassword, issueStaffToken, verifyPassword } from "../src/services/staff-auth";

test("staff JWT authentication and authorization", async (t) => {
  function stub(target: object, method: string, implementation: (...args: never[]) => unknown) {
    const original: unknown = Reflect.get(target, method);
    Object.defineProperty(target, method, { value: implementation, configurable: true, writable: true });
    t.after(() => {
      Object.defineProperty(target, method, { value: original, configurable: true, writable: true });
    });
  }
  const password = "correct horse battery staple";
  const passwordHash = await hashPassword(password);
  let user: StaffUser = {
    id: "staff-test",
    email: "staff@example.test",
    name: "Test Staff",
    role: "moderator",
    passwordHash,
    creatorId: null,
    disabled: false,
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let key: StaffSigningKey | null = null;
  const otherUsers = new Map<string, StaffUser>();
  const findUser = (where: { email?: string; id?: string }) =>
    [user, ...otherUsers.values()].find((entry) => where.email === entry.email || where.id === entry.id) ?? null;
  stub(prisma.staffSigningKey, "findUnique", async () => key);
  stub(prisma.staffSigningKey, "upsert", async (args: { create: Omit<StaffSigningKey, "createdAt"> }) => {
    key ??= { ...args.create, createdAt: new Date() };
    return key;
  });
  stub(prisma.staffUser, "findUnique", async (args: { where: { email?: string; id?: string } }) => findUser(args.where));
  stub(prisma.staffUser, "findUniqueOrThrow", async (args: { where: { id: string } }) => {
    const found = findUser(args.where);
    assert.ok(found);
    return found;
  });
  stub(prisma.staffUser, "findMany", async () => [user, ...otherUsers.values()]);
  stub(prisma.staffUser, "create", async (args: {
    data: Pick<StaffUser, "email" | "name" | "role" | "passwordHash"> & { creatorId?: string | null };
  }) => {
    const created: StaffUser = {
      ...user,
      ...args.data,
      id: `staff-created-${otherUsers.size}`,
      creatorId: args.data.creatorId ?? null,
      disabled: false,
      tokenVersion: 0,
    };
    otherUsers.set(created.id, created);
    return created;
  });
  stub(prisma.staffUser, "update", async (args: {
    where: { id: string };
    data: { tokenVersion: { increment: number }; passwordHash?: string; role?: StaffUser["role"]; disabled?: boolean };
  }) => {
    const found = findUser(args.where);
    assert.ok(found);
    found.tokenVersion += args.data.tokenVersion.increment;
    if (args.data.passwordHash !== undefined) found.passwordHash = args.data.passwordHash;
    if (args.data.role !== undefined) found.role = args.data.role;
    if (args.data.disabled !== undefined) found.disabled = args.data.disabled;
    return found;
  });
  stub(prisma.printJob, "findMany", async () => []);
  stub(prisma.artist, "findUnique", async () => ({ id: "artist-test", suspended: false }));
  stub(prisma.auditLog, "create", async () => ({}));
  const server = buildApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const call = (path: string, options: RequestInit = {}) => fetch(`${base}${path}`, options);
  const login = (body: Record<string, string>) => call("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  await t.test("passwords use salted hashes and reject incorrect passwords", async () => {
    assert.notEqual(await hashPassword(password), passwordHash);
    assert.equal(await verifyPassword(password, passwordHash), true);
    assert.equal(await verifyPassword("incorrect password", passwordHash), false);
    await assert.rejects(verifyPassword(password, "invalid"), /Invalid stored/);
  });

  await t.test("legacy staff-key and role headers cannot authenticate", async () => {
    const response = await call("/admin/me", { headers: { "x-admin-role": "super", "x-staff-key": "anything" } });
    assert.equal(response.status, 401);
    const preflight = await call("/config", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,x-admin-role,x-admin-name",
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Authorization/i);
  });

  await t.test("login checks credentials, stores role in signed JWT, and excludes secrets", async () => {
    assert.equal((await login({ email: user.email, password: "incorrect" })).status, 401);
    assert.equal((await login({ email: "missing@example.test", password })).status, 401);
    assert.equal((await login({ email: user.email, password, role: "super" })).status, 400);
    const response = await login({ email: " STAFF@example.test ", password });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const data = await response.json();
    assert.equal(data.tokenType, "Bearer");
    assert.equal(data.expiresIn, 3600);
    assert.equal(data.user.role, "moderator");
    assert.equal("passwordHash" in data.user, false);
    assert.ok(key);
    const claims = jwt.verify(data.accessToken, key.publicKey, {
      algorithms: ["RS256"], issuer: "introvart", audience: "introvart-staff",
    });
    assert.ok(typeof claims !== "string");
    assert.equal(claims.role, "moderator");
    assert.equal(claims.sub, user.id);
    const me = await call("/admin/me", { headers: { ...bearer(data.accessToken), "x-admin-role": "super", "x-admin-name": "Forged" } });
    assert.equal(me.status, 200);
    const profile = await me.json();
    assert.equal(profile.role, "moderator");
    assert.equal(profile.name, user.name);
    assert.equal((await call("/admin/finance", { headers: bearer(data.accessToken) })).status, 403);
    assert.equal((await call("/fulfil/jobs", { headers: bearer(data.accessToken) })).status, 403);
  });

  await t.test("rejects tampered, expired, wrong-audience and wrong-algorithm JWTs", async () => {
    assert.ok(key);
    const payload = { role: user.role, version: user.tokenVersion, creatorId: null };
    const options = { issuer: "introvart", audience: "introvart-staff", subject: user.id };
    const expired = jwt.sign(payload, key.privateKey, { ...options, algorithm: "RS256", expiresIn: -1 });
    const wrongAudience = jwt.sign(payload, key.privateKey, { ...options, audience: "other", algorithm: "RS256", expiresIn: 60 });
    const wrongAlgorithm = jwt.sign(payload, "attacker-secret", { ...options, algorithm: "HS256", expiresIn: 60 });
    const valid = (await issueStaffToken(user)).accessToken;
    const segments = valid.split(".");
    const decoded = jwt.decode(valid);
    assert.ok(decoded && typeof decoded !== "string");
    segments[1] = Buffer.from(JSON.stringify({ ...decoded, role: "super" })).toString("base64url");
    for (const token of [expired, wrongAudience, wrongAlgorithm, segments.join("."), "not-a-jwt"]) {
      assert.equal((await call("/admin/me", { headers: bearer(token) })).status, 401);
    }
  });

  await t.test("account role changes, disablement and session revocation invalidate tokens", async () => {
    const token = (await issueStaffToken(user)).accessToken;
    user.role = "super";
    assert.equal((await call("/admin/me", { headers: bearer(token) })).status, 401);
    user.role = "moderator";
    user.disabled = true;
    assert.equal((await call("/admin/me", { headers: bearer(token) })).status, 401);
    assert.equal((await login({ email: user.email, password })).status, 401);
    user.disabled = false;
    user.tokenVersion += 1;
    assert.equal((await call("/admin/me", { headers: bearer(token) })).status, 401);
  });

  await t.test("operations can access fulfilment and logout revokes the token", async () => {
    user.role = "operations";
    const token = (await issueStaffToken(user)).accessToken;
    assert.equal((await call("/fulfil/jobs", { headers: bearer(token) })).status, 200);
    assert.equal((await call("/auth/logout", { method: "POST", headers: bearer(token) })).status, 204);
    assert.equal((await call("/auth/me", { headers: bearer(token) })).status, 401);
  });

  await t.test("creator identity comes from the token, not a caller-provided header", async () => {
    user.role = "creator";
    user.creatorId = "artist-test";
    const token = (await issueStaffToken(user)).accessToken;
    const response = await call("/creator/me", { headers: { ...bearer(token), "x-creator-id": "another-artist" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, "artist-test");
    assert.equal((await call("/admin/me", { headers: bearer(token) })).status, 401);
    assert.equal((await call("/fulfil/jobs", { headers: bearer(token) })).status, 401);
  });

  await t.test("super can create and manage staff, with no self-promotion or secret exposure", async () => {
    user.role = "super";
    user.creatorId = null;
    const token = (await issueStaffToken(user)).accessToken;
    const request = (path: string, method: string, body: object) => call(path, {
      method,
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await request("/auth/staff", "POST", {
      email: "new@example.test", name: "New Staff", password, role: "support",
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.role, "support");
    assert.equal("passwordHash" in created, false);
    const stored = otherUsers.get(created.id);
    assert.ok(stored);
    assert.notEqual(stored.passwordHash, password);
    assert.equal(await verifyPassword(password, stored.passwordHash), true);
    const createdToken = (await issueStaffToken(stored)).accessToken;
    const list = await call("/auth/staff", { headers: bearer(token) });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).some((entry: object) => "passwordHash" in entry), false);
    assert.equal((await request(`/auth/staff/${user.id}`, "PATCH", { role: "support" })).status, 400);
    assert.equal((await request(`/auth/staff/${stored.id}`, "PATCH", { role: "creator" })).status, 400);
    assert.equal((await request(`/auth/staff/${stored.id}`, "PATCH", { role: "finance" })).status, 200);
    assert.equal((await call("/admin/me", { headers: bearer(createdToken) })).status, 401);
    const changedToken = (await issueStaffToken(stored)).accessToken;
    assert.equal((await request(`/auth/staff/${stored.id}`, "PATCH", { disabled: true })).status, 200);
    assert.equal((await call("/admin/me", { headers: bearer(changedToken) })).status, 401);
    assert.equal((await request("/auth/staff", "POST", {
      email: "creator@example.test", name: "Creator", password, role: "creator",
    })).status, 400);
  });

  await t.test("changing own password requires the old password and revokes existing tokens", async () => {
    const token = (await issueStaffToken(user)).accessToken;
    const request = (currentPassword: string, newPassword: string) => call("/auth/password", {
      method: "POST",
      headers: { ...bearer(token), "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    assert.equal((await request("wrong", "new long password")).status, 400);
    assert.equal((await request(password, "short")).status, 400);
    assert.equal((await request(password, "new long password")).status, 204);
    assert.equal(await verifyPassword("new long password", user.passwordHash), true);
    assert.equal((await call("/auth/me", { headers: bearer(token) })).status, 401);
  });

  await t.test("non-super accounts cannot provision staff and login is rate limited", async () => {
    user.role = "moderator";
    user.creatorId = null;
    const token = (await issueStaffToken(user)).accessToken;
    assert.equal((await call("/auth/staff", { headers: bearer(token) })).status, 403);
    assert.equal((await call("/auth/staff", { method: "POST", headers: bearer(token) })).status, 403);
    assert.equal((await call("/admin/products")).status, 401);
    assert.equal((await call("/admin/products", { headers: bearer(token) })).status, 403);
    assert.equal((await call("/admin/products", { method: "POST", headers: bearer(token) })).status, 403);
    assert.equal((await call("/admin/products/import", { method: "POST", headers: bearer(token) })).status, 403);
    let status = 0;
    for (let attempt = 0; attempt < 11 && status !== 429; attempt += 1) {
      status = (await login({ email: user.email, password: "incorrect" })).status;
    }
    assert.equal(status, 429);
  });
});
