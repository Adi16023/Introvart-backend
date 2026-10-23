import type { NextFunction, Request, Response } from "express";
import { ZodType, z } from "zod";
import { Prisma } from "@prisma/client";
import crypto from "node:crypto";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const unauthorized = (message = "Sign in required") => new HttpError(401, message);
export const forbidden = (message = "Not allowed") => new HttpError(403, message);
export const notFound = (message = "Not found") => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(
      400,
      "Invalid request",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return result.data;
}

export const param = (req: Request, name: string) => String(req.params[name]);

export function uid(prefix: string) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function displayDate(date = new Date()) {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, details: error.details });
    return;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      res.status(409).json({ error: "That value already exists" });
      return;
    }
    if (error.code === "P2025") {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }
  if (error instanceof SyntaxError) {
    res.status(400).json({ error: "Malformed JSON" });
    return;
  }
  if (error instanceof Error && error.name === "MulterError") {
    const tooBig = (error as Error & { code?: string }).code === "LIMIT_FILE_SIZE";
    res.status(tooBig ? 413 : 400).json({ error: tooBig ? "That file is too large" : "Upload could not be read" });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Something went wrong" });
}
