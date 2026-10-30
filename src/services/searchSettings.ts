import { z } from "zod";
import { json, prisma } from "../lib/db";

const KEY = "search";

export const searchSettingsSchema = z.object({
  placeholders: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
  rotate: z.boolean(),
  intervalSeconds: z.number().int().min(2).max(20),
});

export type SearchSettings = z.infer<typeof searchSettingsSchema>;

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  placeholders: ["Search art, artists, rooms, occasions"],
  rotate: true,
  intervalSeconds: 4,
};

export async function loadSearchSettings(): Promise<SearchSettings> {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  const parsed = searchSettingsSchema.safeParse(row?.data);
  return parsed.success ? parsed.data : DEFAULT_SEARCH_SETTINGS;
}

export async function saveSearchSettings(input: SearchSettings): Promise<SearchSettings> {
  await prisma.siteSetting.upsert({ where: { key: KEY }, update: { data: json(input) }, create: { key: KEY, data: json(input) } });
  return input;
}
