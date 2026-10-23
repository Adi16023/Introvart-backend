import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import multer from "multer";
import type { Readable } from "node:stream";
import { prisma } from "../lib/db";
import { badRequest, HttpError, notFound } from "../lib/http";
import { needAdmin, needCreator, needOwner, staffGate } from "../lib/identity";
import { actorsFor } from "../lib/media";
import { getObject, KEY_PATTERN, KINDS, kindOfKey, MAX_UPLOAD_BYTES, mediaUrl, newKey, putObject, sniff, type MediaKind } from "../lib/storage";

export const mediaRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 } });

function runChain(req: Request, res: Response, chain: RequestHandler[], done: NextFunction) {
  let index = 0;
  const step = (error?: unknown) => {
    if (error) return done(error);
    const handler = chain[index++];
    if (!handler) return done();
    try {
      const result = handler(req, res, step) as unknown;
      if (result instanceof Promise) result.catch(done);
    } catch (caught) {
      done(caught);
    }
  };
  step();
}

// The kind rides on the query string so the caller is authenticated before any bytes are read.
function guard(req: Request, res: Response, next: NextFunction) {
  const kind = String(req.query.kind ?? "") as MediaKind;
  if (!(kind in KINDS)) return next(badRequest(`kind must be one of ${Object.keys(KINDS).join(", ")}`));
  const actor = KINDS[kind].actor;
  const chain: RequestHandler[] = actor === "creator" ? [staffGate, needCreator] : actor === "admin" ? [staffGate, needAdmin("cms")] : [needOwner];
  runChain(req, res, chain, next);
}

mediaRouter.post("/uploads", guard, upload.single("file"), async (req, res) => {
  const kind = String(req.query.kind) as MediaKind;
  if (!req.file) throw badRequest('Send the file as multipart form data in a field named "file"');
  const config = KINDS[kind];
  const detected = sniff(req.file.buffer);
  if (!detected || !(config.allow as readonly string[]).includes(detected.type)) {
    throw new HttpError(415, `A ${kind} upload must be one of: ${config.allow.join(", ")}`);
  }
  if (req.file.size > config.maxBytes) throw new HttpError(413, `A ${kind} upload can be at most ${Math.round(config.maxBytes / 1048576)} MB`);

  const owner = actorsFor(req, kind)[0];
  const key = newKey(kind, detected.ext);
  await putObject(key, req.file.buffer, detected.type);
  await prisma.upload.create({ data: { key, kind, ownerId: owner, contentType: detected.type, size: req.file.size } });
  res.status(201).json({ key, url: mediaUrl(key), kind, contentType: detected.type, size: req.file.size, visibility: config.visibility });
});

// The bucket is private; files are streamed through the API so access rules stay in one place.
mediaRouter.get("/media/*key", async (req, res) => {
  const segments = req.params.key as unknown as string[];
  const key = Array.isArray(segments) ? segments.join("/") : String(segments);
  const kind = kindOfKey(key);
  if (!kind || !KEY_PATTERN.test(key)) throw notFound("File not found");

  let object;
  try {
    object = await getObject(key);
  } catch (error) {
    if ((error as { name?: string }).name === "NoSuchKey") throw notFound("File not found");
    throw error;
  }
  res.set({
    "Content-Type": object.ContentType ?? "application/octet-stream",
    "Cache-Control": KINDS[kind].visibility === "public" ? "public, max-age=31536000, immutable" : "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    // Storefronts on other origins embed these files.
    "Cross-Origin-Resource-Policy": "cross-origin",
    ...(object.ContentLength !== undefined ? { "Content-Length": String(object.ContentLength) } : {}),
    ...(object.ETag ? { ETag: object.ETag } : {}),
  });
  const body = object.Body as Readable;
  body.on("error", () => res.destroy());
  body.pipe(res);
});
