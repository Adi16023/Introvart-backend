import type { Request } from "express";
import { z } from "zod";
import { json, prisma } from "../lib/db";
import { badRequest } from "../lib/http";
import { resolveOne } from "../lib/media";
import { canonicalMediaUrl, keyFromRef } from "../lib/storage";

const tabIds = ["shop", "collections", "help"] as const;
const categoryIds = ["new-arrivals", "featured", "artwork-gifts", "all-artwork"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const href = z.string().trim().min(1).max(500)
  .refine((value) => /^\/(?!\/)/.test(value) || /^https:\/\//i.test(value), "Use a path such as /shop or an https:// link");
const image = z.string().trim().max(2000).default("");

const bannerSchema = z.object({
  id: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
  eyebrow: z.string().trim().max(60).default(""),
  title: text(80),
  buttonLabel: z.string().trim().max(30).default(""),
  href,
  image,
});

export const menuSchema = z.object({
  tabs: z.array(z.object({ id: z.enum(tabIds), label: text(30), visible: z.boolean() })).length(3),
  shop: z.object({
    categories: z.array(z.object({ id: z.enum(categoryIds), title: text(40), href, visible: z.boolean() })).length(4),
    banners: z.array(bannerSchema).max(3),
  }),
  collections: z.object({ heading: text(60), banners: z.array(bannerSchema).max(3) }),
  help: z.object({
    headline: text(120),
    tiles: z.array(z.object({ title: text(40), href, image })).max(3),
    links: z.array(z.object({ title: text(40), href })).max(10),
  }),
}).superRefine((menu, context) => {
  if (new Set(menu.tabs.map((tab) => tab.id)).size !== menu.tabs.length) {
    context.addIssue({ code: "custom", path: ["tabs"], message: "Each header menu must appear exactly once" });
  }
  if (!menu.tabs.some((tab) => tab.visible)) {
    context.addIssue({ code: "custom", path: ["tabs"], message: "Keep at least one header menu visible" });
  }
  if (new Set(menu.shop.categories.map((category) => category.id)).size !== menu.shop.categories.length) {
    context.addIssue({ code: "custom", path: ["shop", "categories"], message: "Each shop heading must appear exactly once" });
  }
});

export type MenuConfig = z.infer<typeof menuSchema>;

export const DEFAULT_MENU: MenuConfig = {
  tabs: [
    { id: "shop", label: "Shop", visible: true },
    { id: "collections", label: "Collections", visible: true },
    { id: "help", label: "Help", visible: true },
  ],
  shop: {
    categories: [
      { id: "new-arrivals", title: "New arrivals", href: "/shop?sort=newest", visible: true },
      { id: "featured", title: "Featured", href: "/shop?sort=featured", visible: true },
      { id: "artwork-gifts", title: "Artwork gifts", href: "/occasions", visible: true },
      { id: "all-artwork", title: "All artwork", href: "/shop", visible: true },
    ],
    banners: [],
  },
  collections: { heading: "All collections", banners: [] },
  help: {
    headline: "Here to help you find your next favourite piece.",
    tiles: [
      { title: "Our Story", href: "/about", image: "/rooms/living-room.webp" },
      { title: "Our Journal", href: "/blog", image: "/rooms/office-room.webp" },
      { title: "Our Services", href: "/about", image: "/rooms/hallway-room.webp" },
    ],
    links: [
      { title: "About us", href: "/about" },
      { title: "Contact us", href: "/about" },
      { title: "Blogs", href: "/blog" },
      { title: "FAQs", href: "/about" },
    ],
  },
};

const mapImages = (menu: MenuConfig, convert: (ref: string) => string): MenuConfig => ({
  ...menu,
  shop: { ...menu.shop, banners: menu.shop.banners.map((banner) => ({ ...banner, image: convert(banner.image) })) },
  collections: { ...menu.collections, banners: menu.collections.banners.map((banner) => ({ ...banner, image: convert(banner.image) })) },
  help: { ...menu.help, tiles: menu.help.tiles.map((tile) => ({ ...tile, image: convert(tile.image) })) },
});

export async function loadMenu(): Promise<MenuConfig> {
  const row = await prisma.menuConfig.findUnique({ where: { id: 1 } });
  const parsed = menuSchema.safeParse(row?.data);
  return mapImages(parsed.success ? parsed.data : DEFAULT_MENU, (ref) => (ref ? canonicalMediaUrl(ref) : ""));
}

// Menu images are either files uploaded through POST /uploads?kind=cms or static assets served by the storefront.
async function resolveImage(req: Request, ref: string, field: string) {
  if (!ref) return "";
  if (keyFromRef(ref)) return resolveOne(req, ref, ["cms"], field);
  if (/^\/(?!\/)/.test(ref)) return ref;
  throw badRequest(`${field} must be an uploaded image or a site path`);
}

export async function saveMenu(req: Request, input: MenuConfig): Promise<MenuConfig> {
  const shopBanners = await Promise.all(input.shop.banners.map(async (banner) => ({ ...banner, image: await resolveImage(req, banner.image, "Shop banner image") })));
  const collectionBanners = await Promise.all(input.collections.banners.map(async (banner) => ({ ...banner, image: await resolveImage(req, banner.image, "Collections banner image") })));
  const tiles = await Promise.all(input.help.tiles.map(async (tile) => ({ ...tile, image: await resolveImage(req, tile.image, "Help tile image") })));
  const data: MenuConfig = {
    ...input,
    shop: { ...input.shop, banners: shopBanners },
    collections: { ...input.collections, banners: collectionBanners },
    help: { ...input.help, tiles },
  };
  await prisma.menuConfig.upsert({ where: { id: 1 }, update: { data: json(data) }, create: { id: 1, data: json(data) } });
  return mapImages(data, (ref) => (ref ? canonicalMediaUrl(ref) : ""));
}
