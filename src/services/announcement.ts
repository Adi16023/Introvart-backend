import { z } from "zod";
import { json, prisma } from "../lib/db";
import { loadConfig } from "./pricing";

const KEY = "announcement";

const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #e10600");
const href = z.string().trim().max(500)
  .refine((value) => value === "" || /^\/(?!\/)/.test(value) || /^https:\/\//i.test(value), "Use a path such as /shop or an https:// link");

export const announcementSchema = z.object({
  enabled: z.boolean(),
  speed: z.enum(["slow", "normal", "fast"]),
  pauseOnHover: z.boolean(),
  background: hex,
  textColor: hex,
  messages: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(160),
    href: href.default(""),
  })).max(10),
});

export type Announcement = z.infer<typeof announcementSchema>;

// Until staff save their own messages, the bar keeps showing the free-shipping message it always had.
async function defaultAnnouncement(): Promise<Announcement> {
  const config = await loadConfig();
  const frames = config.frames.filter((frame) => frame.id !== "none").map((frame) => frame.label);
  const text = config.freeShippingOver > 0
    ? `Free standard shipping over ₹${config.freeShippingOver.toLocaleString("en-IN")}${frames.length ? ` · ${frames.join(", ")} frames` : ""}`
    : "";
  return {
    enabled: true,
    speed: "normal",
    pauseOnHover: true,
    background: "#e10600",
    textColor: "#ffffff",
    messages: text ? [{ id: "free-shipping", text, href: "" }] : [],
  };
}

export async function loadAnnouncement(): Promise<Announcement> {
  const row = await prisma.siteSetting.findUnique({ where: { key: KEY } });
  const parsed = announcementSchema.safeParse(row?.data);
  return parsed.success ? parsed.data : defaultAnnouncement();
}

export async function saveAnnouncement(input: Announcement): Promise<Announcement> {
  await prisma.siteSetting.upsert({ where: { key: KEY }, update: { data: json(input) }, create: { key: KEY, data: json(input) } });
  return input;
}
