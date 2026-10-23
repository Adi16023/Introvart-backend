import type { NextFunction, Request, Response } from "express";
import { env } from "../lib/env";
import { prisma } from "../lib/db";
import { badRequest, forbidden, unauthorized } from "../lib/http";

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
    }
  }
}

// Placeholder identity until real auth is added: the client states who it is.
// Customers send x-customer-id, anonymous shoppers x-guest-id, creators x-creator-id,
// staff x-admin-role (+ optional x-admin-name). Staff surfaces also need x-staff-key.
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
  const role = header("x-admin-role");
  req.adminRole = role && (ADMIN_ROLES as string[]).includes(role) ? (role as AdminRole) : undefined;
  req.adminName = header("x-admin-name");
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

export function staffGate(req: Request, _res: Response, next: NextFunction) {
  if (env.staffKey && req.header("x-staff-key") !== env.staffKey) {
    return next(unauthorized("Staff key missing or wrong"));
  }
  next();
}

export async function needCreator(req: Request, _res: Response, next: NextFunction) {
  if (!req.creatorId) return next(unauthorized("Send x-creator-id"));
  const artist = await prisma.artist.findUnique({ where: { id: req.creatorId }, select: { id: true, suspended: true } });
  if (!artist) return next(unauthorized("Unknown creator"));
  if (artist.suspended) return next(forbidden("This studio is suspended"));
  next();
}

export function needAdmin(desk: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.adminRole) return next(unauthorized("Send x-admin-role"));
    if (!canAccess(req.adminRole, desk)) return next(forbidden(`The ${req.adminRole} role does not open ${desk || "this desk"}`));
    next();
  };
}

export const actorLabel = (req: Request) => {
  const role = req.adminRole ?? "system";
  const label = role.charAt(0).toUpperCase() + role.slice(1);
  return req.adminName ? `${label} · ${req.adminName}` : label;
};
