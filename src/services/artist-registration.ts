import { Prisma } from "@prisma/client";
import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";
import { z } from "zod";
import { prisma } from "../lib/db";
import { conflict, parse, slugify, uid } from "../lib/http";
import { hashPassword, issueStaffToken } from "./staff-auth";

export const portfolioUrl = z.string().trim().max(2048).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, "Enter a valid http:// or https:// URL");

export const behanceUrl = portfolioUrl.refine(value => {
  if (!value) return true;
  try {
    return ["behance.net", "www.behance.net"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}, "Enter a behance.net profile URL");

export const artistRegistration = z.object({
  firstName: z.string().trim().min(1).max(40),
  lastName: z.string().trim().min(1).max(40),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().max(24).regex(/^\+?[0-9 ()-]+$/, "Enter a valid phone number")
    .transform(value => value.replace(/[ ()-]/g, ""))
    .refine(value => /^\+?[0-9]{10,15}$/.test(value), "Phone number must contain 10 to 15 digits"),
  accountType: z.enum(["Individual", "Business"]),
  gst: z.string().trim().toUpperCase().regex(/^$|^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Enter a valid 15-character GSTIN").default(""),
  websiteUrl: portfolioUrl.default(""),
  behanceUrl: behanceUrl.default(""),
  portfolioLinks: z.array(portfolioUrl.refine(value => !!value, "A link cannot be empty")).max(5).default([]),
  password: z.string().min(8).max(128)
    .regex(/[A-Z]/, "Password needs an uppercase letter")
    .regex(/[a-z]/, "Password needs a lowercase letter")
    .regex(/[0-9]/, "Password needs a number")
    .regex(/[^A-Za-z0-9\s]/, "Password needs a special character"),
  confirmPassword: z.string().max(128),
}).strict()
  .refine(value => value.password === value.confirmPassword, { path: ["confirmPassword"], message: "Passwords do not match" })
  .refine(value => value.accountType === "Business" || !value.gst, { path: ["gst"], message: "GSTIN applies only to Business accounts" })
  .refine(value => `${value.firstName} ${value.lastName}`.length <= 80, { path: ["lastName"], message: "Full name must be at most 80 characters" });

export const registrationLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts. Try again in 15 minutes" },
});

export const registerArtist: RequestHandler = async (req, res) => {
  const body = parse(artistRegistration, req.body);
  if (await prisma.admin.findUnique({ where: { email: body.email }, select: { id: true } })) {
    throw conflict("An account with this email already exists. Sign in instead.");
  }
  const passwordHash = await hashPassword(body.password);
  const name = `${body.firstName} ${body.lastName}`;
  const id = uid("cr").toLowerCase();
  try {
    const session = await prisma.$transaction(async tx => {
      await tx.artist.create({
        data: {
          id, slug: `${slugify(name) || "studio"}-${id.slice(3)}`, name,
          firstName: body.firstName, lastName: body.lastName,
          email: body.email, phone: body.phone, accountType: body.accountType,
          gst: body.gst || null, websiteUrl: body.websiteUrl,
          behanceUrl: body.behanceUrl, portfolioLinks: body.portfolioLinks,
        },
      });
      const user = await tx.admin.create({
        data: { email: body.email, name, passwordHash, role: "creator", creatorId: id },
      });
      return issueStaffToken(user);
    });
    res.set("Cache-Control", "no-store").status(201).json(session);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" &&
      Array.isArray(error.meta?.target) && error.meta.target.includes("email")) {
      throw conflict("An account with this email already exists. Sign in instead.");
    }
    throw error;
  }
};
