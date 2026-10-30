import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../lib/db";
import { badRequest, notFound, param, parse } from "../lib/http";
import { actorLabel, needAdmin, staffGate } from "../lib/identity";
import { hashPassword, loginStaff, staffProfile, verifyPassword } from "../services/staff-auth";
import { audit } from "../services/audit";

export const staffAuthRouter = Router();
const password = z.string().min(9).max(128);
const email = z.string().trim().toLowerCase().email().max(254);
const role = z.enum(["moderator", "support", "operations", "finance", "marketing", "super", "creator"]);
const account = z.object({
  email,
  name: z.string().trim().min(2).max(80),
  password,
  role,
  creatorId: z.string().min(1).nullable().optional(),
}).strict();

staffAuthRouter.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

staffAuthRouter.post("/login", rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Try again in 15 minutes" },
}), async (req, res) => {
  const body = parse(z.object({ email, password: z.string().min(1).max(128) }).strict(), req.body);
  res.json(await loginStaff(body.email, body.password));
});

staffAuthRouter.use(staffGate);

staffAuthRouter.get("/me", async (req, res) => {
  const user = await prisma.admin.findUniqueOrThrow({ where: { id: req.staffId } });
  res.json(staffProfile(user));
});

staffAuthRouter.post("/logout", async (req, res) => {
  await prisma.admin.update({ where: { id: req.staffId }, data: { tokenVersion: { increment: 1 } } });
  res.status(204).end();
});

staffAuthRouter.post("/password", async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }).strict(), req.body);
  const user = await prisma.admin.findUniqueOrThrow({ where: { id: req.staffId } });
  if (!await verifyPassword(body.currentPassword, user.passwordHash)) {
    throw badRequest("Current password is incorrect");
  }
  await prisma.admin.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(body.newPassword), tokenVersion: { increment: 1 } },
  });
  await audit(prisma, actorLabel(req), `Changed password for staff account ${user.email}`);
  res.status(204).end();
});

staffAuthRouter.get("/staff", needAdmin("roles"), async (_req, res) => {
  const users = await prisma.admin.findMany({ orderBy: { createdAt: "asc" } });
  res.json(users.map((user) => ({ ...staffProfile(user), disabled: user.disabled })));
});

staffAuthRouter.post("/staff", needAdmin("roles"), async (req, res) => {
  const body = parse(account, req.body);
  if (body.role === "creator" && !body.creatorId) throw badRequest("A creator account requires creatorId");
  if (body.creatorId && !await prisma.artist.findUnique({ where: { id: body.creatorId }, select: { id: true } })) {
    throw badRequest("Unknown creator");
  }
  const user = await prisma.admin.create({
    data: { email: body.email, name: body.name, role: body.role, creatorId: body.creatorId, passwordHash: await hashPassword(body.password) },
  });
  await audit(prisma, actorLabel(req), `Created staff account ${user.email} with role ${user.role}`);
  res.status(201).json(staffProfile(user));
});

staffAuthRouter.patch("/staff/:id", needAdmin("roles"), async (req, res) => {
  const body = parse(z.object({
    role: role.optional(),
    disabled: z.boolean().optional(),
    password: password.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0), req.body);
  const id = param(req, "id");
  if (id === req.staffId) throw badRequest("Use another super administrator to change this account");
  const existing = await prisma.admin.findUnique({ where: { id } });
  if (!existing) throw notFound("Staff account not found");
  if (body.role === "creator" && !existing.creatorId) throw badRequest("A creator account requires creatorId");
  const user = await prisma.admin.update({
    where: { id },
    data: {
      role: body.role,
      disabled: body.disabled,
      ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}),
      tokenVersion: { increment: 1 },
    },
  });
  await audit(prisma, actorLabel(req), `Updated staff account ${user.email}: role ${user.role}, disabled ${user.disabled}`);
  res.json({ ...staffProfile(user), disabled: user.disabled });
});
