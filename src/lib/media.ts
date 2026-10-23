import type { Request } from "express";
import { prisma } from "./db";
import { badRequest } from "./http";
import { KINDS, keyFromRef, mediaUrl, type MediaKind } from "./storage";

// Who may reference an upload of a given kind: shoppers may also use what they uploaded as a guest.
export function actorsFor(req: Request, kind: MediaKind): string[] {
  const actor = KINDS[kind].actor;
  if (actor === "creator") return req.creatorId ? [`creator:${req.creatorId}`] : [];
  if (actor === "admin") return ["admin"];
  const guest = req.header("x-guest-id");
  return [req.ownerId, guest ? `guest:${guest}` : undefined].filter((value): value is string => Boolean(value));
}

// Every image or document a client submits must be a file that went through POST /uploads.
// Returns canonical bucket URLs so a client can never smuggle in a link to an outside host.
export async function resolveMedia(req: Request, refs: string[], kinds: MediaKind[], field = "image"): Promise<string[]> {
  if (!refs.length) return [];
  const keys = refs.map((ref) => {
    const key = keyFromRef(ref);
    if (!key) {
      throw badRequest(`${field} must be a file uploaded through POST /api/v1/uploads (links and inline data are not accepted)`);
    }
    return key;
  });
  const rows = await prisma.upload.findMany({ where: { key: { in: keys } } });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return keys.map((key) => {
    const row = byKey.get(key);
    if (!row) throw badRequest(`${field} refers to a file that was never uploaded`);
    if (!kinds.includes(row.kind as MediaKind)) throw badRequest(`${field} was uploaded as "${row.kind}" and cannot be used here`);
    if (!actorsFor(req, row.kind as MediaKind).includes(row.ownerId)) throw badRequest(`${field} was uploaded by someone else`);
    return mediaUrl(key);
  });
}

export async function resolveOne(req: Request, ref: string, kinds: MediaKind[], field = "image") {
  return (await resolveMedia(req, [ref], kinds, field))[0];
}
