import crypto from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "./env";
import { HttpError } from "./http";

const IMAGES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const MB = 1024 * 1024;

type Actor = "creator" | "admin" | "shopper";

export const KINDS = {
  product: { folder: "products", actor: "creator", visibility: "public", maxBytes: 25 * MB, allow: IMAGES },
  "creator-profile": { folder: "creators", actor: "creator", visibility: "public", maxBytes: 10 * MB, allow: IMAGES },
  cms: { folder: "cms", actor: "admin", visibility: "public", maxBytes: 10 * MB, allow: IMAGES },
  review: { folder: "reviews", actor: "shopper", visibility: "public", maxBytes: 8 * MB, allow: IMAGES },
  "custom-print": { folder: "custom-prints", actor: "shopper", visibility: "private", maxBytes: 25 * MB, allow: IMAGES },
  return: { folder: "returns", actor: "shopper", visibility: "private", maxBytes: 10 * MB, allow: [...IMAGES, "application/pdf"] },
  commission: { folder: "commissions", actor: "shopper", visibility: "private", maxBytes: 10 * MB, allow: [...IMAGES, "application/pdf"] },
} as const satisfies Record<string, { folder: string; actor: Actor; visibility: "public" | "private"; maxBytes: number; allow: readonly string[] }>;

export type MediaKind = keyof typeof KINDS;
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(KINDS).map((kind) => kind.maxBytes));

export const kindOfKey = (key: string) => (Object.keys(KINDS) as MediaKind[]).find((kind) => key.startsWith(`${KINDS[kind].folder}/`));

// File type comes from the bytes, never from what the client claims.
export function sniff(buffer: Buffer): { type: string; ext: string } | null {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => buffer[index] === byte);
  if (starts(0xff, 0xd8, 0xff)) return { type: "image/jpeg", ext: "jpg" };
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { type: "image/png", ext: "png" };
  if (buffer.subarray(0, 4).toString("latin1") === "GIF8") return { type: "image/gif", ext: "gif" };
  if (buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return { type: "image/webp", ext: "webp" };
  if (buffer.subarray(4, 8).toString("latin1") === "ftyp" && ["avif", "avis"].includes(buffer.subarray(8, 12).toString("latin1"))) return { type: "image/avif", ext: "avif" };
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { type: "application/pdf", ext: "pdf" };
  return null;
}

export function newKey(kind: MediaKind, ext: string) {
  const now = new Date();
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${KINDS[kind].folder}/${month}/${crypto.randomUUID()}.${ext}`;
}

export const KEY_PATTERN = /^[a-z-]+\/\d{4}-\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{3,4}$/;

export const MEDIA_PATH = "/api/v1/media/";
export const mediaUrl = (key: string) => `${env.publicUrl}${MEDIA_PATH}${key}`;

export function keyFromRef(ref: string) {
  try {
    const url = new URL(ref);
    if (!url.pathname.startsWith(MEDIA_PATH)) return null;
    const key = decodeURIComponent(url.pathname.slice(MEDIA_PATH.length));
    return KEY_PATTERN.test(key) ? key : null;
  } catch {
    return null;
  }
}

export function canonicalMediaUrl(ref: string) {
  const key = keyFromRef(ref);
  return key ? mediaUrl(key) : ref;
}

let client: S3Client | null = null;
function s3() {
  if (!env.s3.bucket || !env.s3.endpoint) throw new HttpError(503, "File storage is not configured");
  client ??= new S3Client({ region: env.s3.region, endpoint: env.s3.endpoint, forcePathStyle: true });
  return client;
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  await s3().send(
    new PutObjectCommand({ Bucket: env.s3.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: "public, max-age=31536000, immutable" }),
  );
}

export const getObject = (key: string) => s3().send(new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }));
export const deleteObject = (key: string) => s3().send(new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key }));

export function signedShippingLabel(key: string) {
  return getSignedUrl(s3(), new GetObjectCommand({
    Bucket: env.s3.bucket, Key: key, ResponseContentType: "application/pdf",
    ResponseContentDisposition: 'inline; filename="shipping-label.pdf"', ResponseCacheControl: "private, no-store",
  }), { expiresIn: 300 });
}
