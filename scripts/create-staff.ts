import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { z } from "zod";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/services/staff-auth";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured. Run this command in the connected backend environment.");
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string", default: "super" },
      "creator-id": { type: "string" },
      "new-artist": { type: "boolean", default: false },
      "generate-password": { type: "boolean", default: false },
    },
  });
  const account = z.object({
    email: z.string().trim().toLowerCase().email(),
    name: z.string().trim().min(2).max(80),
    role: z.enum(["moderator", "support", "operations", "finance", "marketing", "super", "creator"]),
    "creator-id": z.string().min(1).optional(),
  }).parse(values);
  const generatedPassword = values["generate-password"] === true;
  if (!generatedPassword && !process.stdin.isTTY) throw new Error("Run this command in an interactive terminal to enter the password securely");
  if (values["new-artist"] && (account.role !== "creator" || account["creator-id"])) throw new Error("--new-artist requires --role creator without --creator-id");
  if (account.role === "creator" && !account["creator-id"] && !values["new-artist"]) throw new Error("--creator-id or --new-artist is required for an artist account");
  if (account["creator-id"] && !await prisma.artist.findUnique({ where: { id: account["creator-id"] }, select: { id: true } })) {
    throw new Error("Unknown creator ID");
  }
  let password: string;
  if (generatedPassword) {
    password = randomBytes(32).toString("base64url");
  } else {
    const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const input = createInterface({ input: process.stdin, output, terminal: true });
    try {
      process.stdout.write("Password (9-128 characters; input hidden): ");
      password = await input.question("");
      process.stdout.write("\nConfirm password (input hidden): ");
      const confirmation = await input.question("");
      process.stdout.write("\n");
      z.string().min(9).max(128).parse(password);
      if (password !== confirmation) throw new Error("Passwords do not match");
    } finally {
      input.close();
    }
  }
  z.string().min(9).max(128).parse(password);
  const passwordHash = await hashPassword(password);
  const user = await prisma.$transaction(async (tx) => {
    let creatorId = account["creator-id"];
    if (values["new-artist"]) {
      const suffix = randomBytes(8).toString("hex");
      const artist = await tx.artist.create({
        data: { id: `cr-${suffix}`, slug: `artist-${suffix}`, name: account.name, email: account.email, styles: [], mediums: [] },
        select: { id: true },
      });
      creatorId = artist.id;
    }
    return tx.admin.create({
      data: { email: account.email, name: account.name, role: account.role, creatorId, passwordHash },
      select: { id: true, email: true, role: true, creatorId: true },
    });
  });
  console.log("Staff account created:", user);
  if (generatedPassword) console.log("Initial password (shown once):", password);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
