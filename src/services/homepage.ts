import { Prisma } from "@prisma/client";
import { z } from "zod";
import { json, prisma } from "../lib/db";
import { conflict } from "../lib/http";
import { canonicalMediaUrl } from "../lib/storage";

const KEY = "homepage";
const href = z.string().trim().max(1000).refine(
  (value) => value === "" || (/^\/(?!\/)/.test(value) && !/[\\\u0000-\u0020]/.test(value)) || /^https:\/\/[^\\\s]+$/i.test(value),
  "Use a site path or HTTPS URL",
);
const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a six-digit hex colour");
const image = z.string().trim().max(2000);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, "Use an alphanumeric identifier");
const cardSchema = z.object({
  id, eyebrow: z.string().max(160), title: z.string().max(200), subtitle: z.string().max(2000),
  image, mobileImage: image, alt: z.string().max(300), href, buttonLabel: z.string().max(80), showText: z.boolean(),
});
export const homepageSectionSchema = z.object({
  id, type: z.enum(["hero", "links", "products", "rooms", "artists", "colours", "occasions", "collections", "recent", "promotion", "cards", "text", "benefits", "spacer"]),
  enabled: z.boolean(), title: z.string().max(200), subtitle: z.string().max(2000),
  eyebrow: z.string().max(160), href, buttonLabel: z.string().max(80),
  background: hex, textColor: hex, align: z.enum(["left", "center"]),
  columns: z.number().int().min(1).max(4), limit: z.number().int().min(1).max(24),
  source: z.enum(["trending", "newest", "selected", "collection"]),
  selection: z.array(z.string().min(1).max(200)).max(24).refine((ids) => new Set(ids).size === ids.length, "Selections must be unique"),
  collectionSlug: z.string().max(200), cards: z.array(cardSchema).max(12)
    .refine((cards) => new Set(cards.map((card) => card.id)).size === cards.length, "Card IDs must be unique"),
  spacing: z.number().int().min(0).max(160),
}).refine((section) => section.type !== "products" || section.source !== "collection" || Boolean(section.collectionSlug), "Choose a collection");
export const homepageSchema = z.object({
  version: z.literal(1),
  sections: z.array(homepageSectionSchema).max(30)
    .refine((sections) => new Set(sections.map((section) => section.id)).size === sections.length, "Section IDs must be unique"),
});
const documentSchema = z.object({
  revision: z.number().int().min(0), draft: homepageSchema, published: homepageSchema, publishedAt: z.string().datetime().nullable(),
});
export const homepageWriteSchema = z.object({ revision: z.number().int().min(0), config: homepageSchema });
export type HomepageConfig = z.infer<typeof homepageSchema>;
export type HomepageDocument = z.infer<typeof documentSchema>;
type Banner = { id: string; eyebrow: string; title: string; subtitle: string; href: string; image: string };

function section(type: HomepageConfig["sections"][number]["type"], id: string, title: string) {
  return {
    id, type, enabled: true, title, subtitle: "", eyebrow: "", href: type === "artists" ? "/artists" : type === "occasions" ? "/occasions" : "/shop",
    buttonLabel: "See all", background: "#ffffff", textColor: "#252525", align: "left" as const,
    columns: 3, limit: type === "artists" ? 6 : 8, source: "trending" as const, selection: [], collectionSlug: "", cards: [], spacing: 40,
  };
}

export function defaultHomepage(banners: Banner[]): HomepageConfig {
  return {
    version: 1, sections: [
      { ...section("hero", "hero", "Hero banners"), spacing: 20, cards: banners.slice(0, 3).map((banner, index) => ({
        ...banner, image: index === 0 ? "/seasonal-home-banner.jpeg" : banner.href === "/custom-print" ? "/custom-photograph-banner.jpeg" : banner.image,
        mobileImage: "", alt: banner.title, buttonLabel: "", showText: index !== 0,
      })) },
      { ...section("links", "links", "Quick links"), limit: 7, spacing: 20 }, { ...section("products", "trending", "Trending now"), spacing: 32 },
      { ...section("rooms", "rooms", "Shop by room"), limit: 6 }, section("artists", "artists", "Artists to follow"),
      { ...section("products", "newest", "Fresh from the studios"), source: "newest" },
      { ...section("colours", "colours", "Shop by colour"), limit: 6 }, { ...section("occasions", "occasions", "Occasions"), limit: 4, columns: 4 },
      section("recent", "recent", "Recently viewed"),
    ],
  };
}

export async function loadHomepage(banners?: Banner[]): Promise<HomepageDocument> {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  if (row) {
    const document = documentSchema.parse(row.data);
    const images = (config: HomepageConfig): HomepageConfig => ({
      ...config, sections: config.sections.map((section) => ({
        ...section, cards: section.cards.map((card) => ({
          ...card, image: card.image ? canonicalMediaUrl(card.image) : "", mobileImage: card.mobileImage ? canonicalMediaUrl(card.mobileImage) : "",
        })),
      })),
    });
    return { ...document, draft: images(document.draft), published: images(document.published) };
  }
  const config = defaultHomepage(banners ?? await prisma.banner.findMany({ where: { active: true }, orderBy: { sort: "asc" }, take: 3 }));
  return { revision: 0, draft: config, published: config, publishedAt: null };
}

export async function saveHomepage(config: HomepageConfig, revision: number, publish: boolean): Promise<HomepageDocument> {
  const current = await loadHomepage();
  if (current.revision !== revision) throw conflict("Another editor saved changes. Reload before saving again.");
  const next: HomepageDocument = {
    revision: revision + 1, draft: config, published: publish ? config : current.published,
    publishedAt: publish ? new Date().toISOString() : current.publishedAt,
  };
  if (revision === 0) {
    try {
      await prisma.siteSetting.create({ data: { key: KEY, data: json(next) } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw conflict("Another editor saved changes. Reload before saving again.");
      throw error;
    }
  } else {
    const result = await prisma.siteSetting.updateMany({
      where: { key: KEY, data: { path: ["revision"], equals: revision } }, data: { data: json(next) },
    });
    if (result.count !== 1) throw conflict("Another editor saved changes. Reload before saving again.");
  }
  return next;
}
