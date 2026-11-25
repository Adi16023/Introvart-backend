import { z } from "zod";
import { json, prisma } from "../lib/db";

const KEY = "search";

const href = z.string().trim().min(1).max(500)
  .refine((value) => /^\/(?!\/)/.test(value) || /^https:\/\//i.test(value), "Use a path such as /shop or an https:// link");

export const searchCategorySchema = z.object({
  label: z.string().trim().min(1).max(60),
  href,
});

export const searchSettingsSchema = z.object({
  placeholders: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
  rotate: z.boolean(),
  intervalSeconds: z.number().int().min(2).max(20),
  mostSearchedTitle: z.string().trim().min(1).max(60),
  mostSearched: z.array(z.string().trim().min(1).max(80)).max(6),
  exploreCategoriesTitle: z.string().trim().min(1).max(60),
  exploreCategories: z.array(searchCategorySchema).max(5),
  recommendedTitle: z.string().trim().min(1).max(60),
  showRecommended: z.boolean(),
  showRecentSearches: z.boolean(),
});

export type SearchSettings = z.infer<typeof searchSettingsSchema>;

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  placeholders: ["art", "artists", "rooms", "occasions"],
  rotate: true,
  intervalSeconds: 4,
  mostSearchedTitle: "Most searched",
  mostSearched: ["framed prints", "abstract art", "living room", "gifts", "originals", "custom print"],
  exploreCategoriesTitle: "Explore best categories",
  exploreCategories: [
    { label: "New arrivals", href: "/shop?sort=newest" },
    { label: "Featured", href: "/shop?sort=featured" },
    { label: "Artwork gifts", href: "/occasions" },
    { label: "Living room", href: "/room/living-room" },
    { label: "All artwork", href: "/shop" },
  ],
  recommendedTitle: "Recommended products",
  showRecommended: true,
  showRecentSearches: true,
};

export async function loadSearchSettings(): Promise<SearchSettings> {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  const stored = row?.data && typeof row.data === "object" && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : {};
  const parsed = searchSettingsSchema.safeParse({ ...DEFAULT_SEARCH_SETTINGS, ...stored });
  return parsed.success ? parsed.data : DEFAULT_SEARCH_SETTINGS;
}

export async function saveSearchSettings(input: SearchSettings): Promise<SearchSettings> {
  await prisma.siteSetting.upsert({ where: { key: KEY }, update: { data: json(input) }, create: { key: KEY, data: json(input) } });
  return input;
}
