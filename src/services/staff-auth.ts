import { generateKeyPair, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import { Prisma, type Admin } from "@prisma/client";
import { prisma } from "../lib/db";
import { unauthorized } from "../lib/http";

const generateKeys = promisify(generateKeyPair);
const deriveKey = promisify(scrypt);
const ISSUER = "introvart";
const AUDIENCE = "introvart-staff";
export const TOKEN_LIFETIME_SECONDS = 3600;
type SigningKeys = { privateKey: string; publicKey: string };

export const staffProfile = (user: Admin) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  creatorId: user.creatorId,
});

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await deriveKey(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, hash: string) {
  const [algorithm, salt, encoded, extra] = hash.split(":");
  if (algorithm !== "scrypt" || !salt || !encoded || extra || !/^[a-f0-9]{128}$/.test(encoded)) {
    throw new Error("Invalid stored staff password hash");
  }
  const actual = await deriveKey(password, salt, 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(encoded, "hex"));
}

function environmentSigningKeys(): SigningKeys | null {
  const privateKey = process.env.STAFF_JWT_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const publicKey = process.env.STAFF_JWT_PUBLIC_KEY?.replace(/\\n/g, "\n");
  if (!privateKey && !publicKey) return null;
  if (!privateKey || !publicKey) {
    throw new Error("Configure both STAFF_JWT_PRIVATE_KEY and STAFF_JWT_PUBLIC_KEY");
  }
  return { privateKey, publicKey };
}

async function signingKey(): Promise<SigningKeys> {
  const configured = environmentSigningKeys();
  if (configured) return configured;
  const existing = await prisma.staffSigningKey.findUnique({ where: { id: 1 } });
  if (existing) return { privateKey: existing.privateKey, publicKey: existing.publicKey };
  const keys = await generateKeys("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  try {
    return await prisma.staffSigningKey.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, privateKey: keys.privateKey, publicKey: keys.publicKey },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return prisma.staffSigningKey.findUniqueOrThrow({ where: { id: 1 } });
    }
    throw error;
  }
}

async function verificationKey() {
  const configured = environmentSigningKeys();
  if (configured) return configured.publicKey;
  const existing = await prisma.staffSigningKey.findUnique({ where: { id: 1 }, select: { publicKey: true } });
  if (!existing) throw unauthorized("Invalid or expired staff token");
  return existing.publicKey;
}

export async function issueStaffToken(user: Admin) {
  const key = await signingKey();
  const accessToken = jwt.sign(
    { role: user.role, version: user.tokenVersion, creatorId: user.creatorId },
    key.privateKey,
    { algorithm: "RS256", issuer: ISSUER, audience: AUDIENCE, subject: user.id, expiresIn: TOKEN_LIFETIME_SECONDS },
  );
  return { accessToken, tokenType: "Bearer", expiresIn: TOKEN_LIFETIME_SECONDS, user: staffProfile(user) };
}

export async function authenticateStaff(token: string) {
  const publicKey = await verificationKey();
  let claims: string | jwt.JwtPayload;
  try {
    claims = jwt.verify(token, publicKey, {
      algorithms: ["RS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      maxAge: TOKEN_LIFETIME_SECONDS,
    });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) throw unauthorized("Invalid or expired staff token");
    throw error;
  }
  if (typeof claims === "string" || typeof claims.sub !== "string" || !claims.sub || typeof claims.exp !== "number" || typeof claims.iat !== "number") {
    throw unauthorized("Invalid or expired staff token");
  }
  const user = await prisma.admin.findUnique({ where: { id: claims.sub } });
  if (!user || user.disabled || user.tokenVersion !== claims.version || user.role !== claims.role || user.creatorId !== claims.creatorId) {
    throw unauthorized("Staff session is no longer valid. Sign in again");
  }
  return user;
}

let dummyHash: Promise<string> | undefined;

export async function loginStaff(email: string, password: string) {
  const user = await prisma.admin.findUnique({ where: { email: email.trim().toLowerCase() } });
  dummyHash ??= hashPassword(randomBytes(32).toString("hex"));
  const valid = await verifyPassword(password, user?.passwordHash ?? await dummyHash);
  if (!valid || !user || user.disabled) throw unauthorized("Invalid email or password");
  return issueStaffToken(user);
}
