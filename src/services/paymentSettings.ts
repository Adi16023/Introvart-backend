import { z } from "zod";
import { Prisma } from "@prisma/client";
import { json, prisma, type Db } from "../lib/db";

const KEY = "payments";

const schema = z.object({ codEnabled: z.boolean() });
export type PaymentSettings = z.infer<typeof schema>;

export async function loadPaymentSettings(db: Db = prisma): Promise<PaymentSettings> {
  try {
    const row = await db.siteSetting.findUnique({ where: { key: KEY } });
    const parsed = schema.safeParse(row?.data);
    return parsed.success ? parsed.data : { codEnabled: true };
  } catch (error) {
    // The settings table arrives with a migration; until then cash on delivery stays as it always was.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2021") return { codEnabled: true };
    throw error;
  }
}

export async function savePaymentSettings(input: PaymentSettings): Promise<PaymentSettings> {
  const data = schema.parse(input);
  await prisma.siteSetting.upsert({ where: { key: KEY }, update: { data: json(data) }, create: { key: KEY, data: json(data) } });
  return data;
}

export const paymentSettingsSchema = schema;
