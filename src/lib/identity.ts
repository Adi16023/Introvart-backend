import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/db";
import { badRequest, forbidden, unauthorized } from "../lib/http";
import { authenticateStaff } from "../services/staff-auth";

export type AdminRole = "moderator" | "support" | "operations" | "finance" | "marketing" | "super";

const ACCESS: Record<AdminRole, string[] | "*"> = {
  super: "*",
  moderator: ["", "moderation", "creators", "copyright", "reviews"],
  support: ["", "customers", "orders", "support", "returns"],
  operations: ["", "orders", "print-jobs", "shipping", "returns"],
  finance: ["", "payments", "payouts", "finance", "gift-cards"],
  marketing: ["", "cms", "promotions", "analytics"],
};

export const ADMIN_ROLES = Object.keys(ACCESS) as AdminRole[];

export function canAccess(role: AdminRole, desk: string) {
  const allowed = ACCESS[role];
  return allowed === "*" || allowed.includes(desk);
}

export const roleMatrix = () => ACCESS;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ownerId?: string;
      customerId?: string;
      creatorId?: string;
      adminRole?: AdminRole;
      adminName?: string;
      staffId?: string;
    }
  }
}

// Shopper identity remains separate from verified staff authentication.
export function identify(req: Request, _res: Response, next: NextFunction) {
  const header = (name: string) => {
    const value = req.header(name);
    return value && value.trim() ? value.trim() : undefined;
  };
  const customer = header("x-customer-id");
  const guest = header("x-guest-id");
  req.customerId = customer;
  req.ownerId = customer ?? (guest ? `guest:${guest}` : undefined);
  req.creatorId = header("x-creator-id");
  next();
}

export function needOwner(req: Request, _res: Response, next: NextFunction) {
  if (!req.ownerId) return next(badRequest("Send x-customer-id or x-guest-id"));
  next();
}

export async function needCustomer(req: Request, _res: Response, next: NextFunction) {
  if (!req.customerId) return next(unauthorized());
  const customer = await prisma.customer.findUnique({ where: { id: req.customerId }, select: { id: true } });
  if (!customer) return next(unauthorized("Unknown customer"));
  next();
}

export async function staffGate(req: Request, _res: Response, next: NextFunction) {
  const authorization = req.header("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match) return next(unauthorized("Sign in with a staff account"));
  try {
    const user = await authenticateStaff(match[1]);
    req.staffId = user.id;
    req.adminRole = user.role === "creator" ? undefined : user.role;
    req.adminName = user.name;
    req.creatorId = user.creatorId ?? undefined;
    next();
  } catch (error) {
    next(error);
  }
}

export async function needCreator(req: Request, _res: Response, next: NextFunction) {
  if (!req.creatorId) return next(unauthorized("This staff account is not linked to a creator"));
  const artist = await prisma.artist.findUnique({ where: { id: req.creatorId }, select: { id: true, suspended: true } });
  if (!artist) return next(unauthorized("Unknown creator"));
  if (artist.suspended) return next(forbidden("This studio is suspended"));
  next();
}

export function needAdmin(desk: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.staffId || !req.adminRole) return next(unauthorized("Sign in with an admin account"));
    if (!canAccess(req.adminRole, desk)) return next(forbidden(`The ${req.adminRole} role does not open ${desk || "this desk"}`));
    next();
  };
}

export const actorLabel = (req: Request) => {
  const role = req.adminRole ?? "system";
  const label = role.charAt(0).toUpperCase() + role.slice(1);
  return req.adminName ? `${label} · ${req.adminName}` : label;
};
