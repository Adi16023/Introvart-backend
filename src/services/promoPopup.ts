import { z } from "zod";
import { json, prisma } from "../lib/db";
import { canonicalMediaUrl } from "../lib/storage";

const KEY = "promo-popup";

const href = z.string().trim().max(500)
  .refine((value) => value === "" || /^\/(?!\/)/.test(value) || /^https:\/\//i.test(value), "Use a path such as /shop or an https:// link");

export const promoPopupSchema = z.object({
  enabled: z.boolean(),
  image: z.string().trim().max(2000),
  href,
  alt: z.string().trim().max(160).default(""),
  contentVersion: z.number().int().min(1).default(1),
});

export type PromoPopup = z.infer<typeof promoPopupSchema>;

export const DEFAULT_PROMO_POPUP: PromoPopup = {
  enabled: false,
  image: "",
  href: "/shop",
  alt: "",
  contentVersion: 1,
};

export async function loadPromoPopup(): Promise<PromoPopup> {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  const stored = row?.data && typeof row.data === "object" && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : {};
  const parsed = promoPopupSchema.safeParse({ ...DEFAULT_PROMO_POPUP, ...stored });
  const data = parsed.success ? parsed.data : DEFAULT_PROMO_POPUP;
  return { ...data, image: canonicalMediaUrl(data.image) };
}

export async function savePromoPopup(input: PromoPopup): Promise<PromoPopup> {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  const previous = promoPopupSchema.safeParse(row?.data);
  const next: PromoPopup = {
    ...input,
    contentVersion: (previous.success ? previous.data.contentVersion : 0) + 1,
  };
  await prisma.siteSetting.upsert({
    where: { key: KEY },
    update: { data: json(next) },
    create: { key: KEY, data: json(next) },
  });
  return { ...next, image: canonicalMediaUrl(next.image) };
}
