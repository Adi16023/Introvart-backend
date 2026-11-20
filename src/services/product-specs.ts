import { z } from "zod";

export const DEFAULT_SPEC_NAME = "Material";

export const SUGGESTED_SPECS = [
  { name: "Medium", options: ["Canvas", "Paper", "Wood", "Metal", "Acrylic"] },
  { name: "Orientation", options: ["Portrait", "Landscape", "Square"] },
  { name: "Frame", options: ["Unframed", "Framed", "Floater frame", "Gallery wrap"] },
  { name: "Finish", options: ["Matte", "Gloss", "Semi-gloss", "Textured"] },
  { name: "Size", options: ["Small", "Medium", "Large", "Custom"] },
] as const;

export const DEFAULT_MATERIAL_OPTIONS = ["Canvas", "Paper", "Wood", "Metal", "Acrylic", "Other"];

export const productSpecSchema = z.object({
  name: z.string().trim().min(1).max(80),
  options: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  // Joined multi-select values (e.g. "Matte · Gloss") need more room than a single label.
  value: z.string().trim().max(500).default(""),
});

export const productSpecTemplateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  options: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
});

export const productSpecsArraySchema = z.array(productSpecSchema).max(30).default([]);
export const productSpecTemplateArraySchema = z.array(productSpecTemplateSchema).max(30).default([]);

export type ProductSpec = z.infer<typeof productSpecSchema>;
export type ProductSpecTemplate = z.infer<typeof productSpecTemplateSchema>;

export function defaultProductSpecs(): ProductSpec[] {
  return [{ name: DEFAULT_SPEC_NAME, options: [...DEFAULT_MATERIAL_OPTIONS], value: "" }];
}

export function normalizeSpecs(input: unknown): ProductSpec[] {
  const parsed = productSpecsArraySchema.catch([]).parse(input);
  const seen = new Set<string>();
  const specs: ProductSpec[] = [];
  for (const spec of parsed) {
    const key = spec.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const options = [...new Set(spec.options.map((option) => option.trim()).filter(Boolean))];
    specs.push({ name: spec.name.trim(), options, value: spec.value.trim() });
  }
  if (!specs.some((spec) => spec.name.toLowerCase() === DEFAULT_SPEC_NAME.toLowerCase())) {
    specs.unshift(...defaultProductSpecs());
  }
  return specs;
}

/** Variant overrides: keep selected values as-is; do not force Material or product catalog defaults. */
export function normalizeVariantSpecs(input: unknown): ProductSpec[] {
  const parsed = productSpecsArraySchema.catch([]).parse(input);
  const seen = new Set<string>();
  const specs: ProductSpec[] = [];
  for (const spec of parsed) {
    const key = spec.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const options = [...new Set(spec.options.map((option) => option.trim()).filter(Boolean))];
    const value = spec.value.trim() || options.join(" · ");
    if (!options.length && !value) continue;
    specs.push({ name: spec.name.trim(), options: options.length ? options : value.split(/\s*[·,]\s*/).map((entry) => entry.trim()).filter(Boolean), value });
  }
  return specs;
}

export function schemaFromSpecs(specs: ProductSpec[]): ProductSpecTemplate[] {
  return specs.map(({ name, options }) => ({ name, options: [...options] }));
}

export function specsFromTemplate(template: unknown): ProductSpec[] {
  const rows = productSpecTemplateArraySchema.catch([]).parse(template);
  if (!rows.length) return defaultProductSpecs();
  return normalizeSpecs(rows.map((row) => ({ ...row, value: "" })));
}

export function sanitizeDescriptionHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
}
