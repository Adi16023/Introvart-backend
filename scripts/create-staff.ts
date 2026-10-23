import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { z } from "zod";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/services/staff-auth";

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string", default: "super" },
      "creator-id": { type: "string" },
    },
  });
  const account = z.object({
    email: z.string().trim().toLowerCase().email(),
    name: z.string().trim().min(2).max(80),
    role: z.enum(["moderator", "support", "operations", "finance", "marketing", "super", "creator"]),
    "creator-id": z.string().min(1).optional(),
  }).parse(values);
  if (!process.stdin.isTTY) throw new Error("Run this command in an interactive terminal to enter the password securely");
  if (account.role === "creator" && !account["creator-id"]) throw new Error("--creator-id is required for a creator account");
  if (account["creator-id"] && !await prisma.artist.findUnique({ where: { id: account["creator-id"] }, select: { id: true } })) {
    throw new Error("Unknown creator ID");
  }
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  let password: string;
  try {
    process.stdout.write("Password (12-128 characters; input hidden): ");
    password = await input.question("");
    process.stdout.write("\nConfirm password (input hidden): ");
    const confirmation = await input.question("");
    process.stdout.write("\n");
    z.string().min(12).max(128).parse(password);
    if (password !== confirmation) throw new Error("Passwords do not match");
  } finally {
    input.close();
  }
  const user = await prisma.staffUser.create({
    data: {
      email: account.email,
      name: account.name,
      role: account.role,
      creatorId: account["creator-id"],
      passwordHash: await hashPassword(password),
    },
    select: { id: true, email: true, role: true },
  });
  console.log("Staff account created:", user);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
