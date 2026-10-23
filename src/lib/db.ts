import { PrismaClient, Prisma } from "@prisma/client";

export const prisma = new PrismaClient();

export type Tx = Prisma.TransactionClient;
export type Db = Tx | PrismaClient;

// Neon sits across a network hop, so interactive transactions need generous limits.
export function transaction<T>(fn: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(fn, { maxWait: 15000, timeout: 60000 });
}

export const json = (value: unknown) => value as Prisma.InputJsonValue;
