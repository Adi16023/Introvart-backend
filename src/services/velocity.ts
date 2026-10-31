import { z } from "zod";
import { env } from "../lib/env";
import { HttpError } from "../lib/http";

const endpoints = [
  "warehouse", "serviceability", "rates", "forward-order", "forward-order-shipment",
  "reverse-order", "reverse-order-shipment", "forward-order-orchestration", "reverse-order-orchestration",
  "cancel-order", "order-tracking", "reports", "shipments", "returns",
] as const;
type Endpoint = (typeof endpoints)[number];

export class VelocityError extends HttpError {
  constructor(public remoteStatus: number, message: string, details?: unknown) {
    super(502, message, details);
  }
}

export function velocityConfigured() {
  return Boolean(env.velocity.apiKey);
}

export async function velocityRequest<T>(endpoint: Endpoint, body: unknown, schema: z.ZodType<T>): Promise<T> {
  if (!velocityConfigured()) throw new HttpError(503, "Velocity is not configured. Set VELOCITY_API_KEY in backend secrets.");
  if (!["https://shazam.velocity.in", "https://shazam.stagingvelocity.in"].includes(env.velocity.baseUrl)) {
    throw new HttpError(503, "Velocity API URL must be the confirmed production or staging HTTPS host.");
  }
  let response: Response;
  try {
    response = await fetch(`${env.velocity.baseUrl}/custom/api/v1/${endpoint}`, {
      method: "POST",
      headers: { Authorization: env.velocity.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new VelocityError(0, "Velocity did not respond. Reconcile the shipment before attempting another booking.");
  }
  if (!response.ok) {
    throw new VelocityError(response.status, response.status === 401
      ? "Velocity rejected the API key. Check its expiry and environment."
      : `Velocity returned HTTP ${response.status}. Check the shipment in Velocity before retrying.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new VelocityError(response.status, "Velocity returned invalid JSON.");
  }
  const envelope = z.object({ status: z.union([z.string(), z.number()]).optional() }).passthrough().safeParse(payload);
  if (!envelope.success || (envelope.data.status !== undefined && !["SUCCESS", 1].includes(envelope.data.status))) {
    throw new VelocityError(response.status, "Velocity reported a shipping operation failure. Review it in the Velocity dashboard.");
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    const paths = [...new Set(issues.map((issue) => issue.path || "response"))];
    const summary = paths.slice(0, 5).join(", ");
    const omitted = paths.length - 5;
    throw new VelocityError(response.status,
      `Velocity returned an unexpected response (schema issues: ${summary}${omitted > 0 ? `, and ${omitted} more` : ""}). Reconcile before retrying.`,
      {
        issues,
      });
  }
  return parsed.data;
}

export const remoteBookingSchema = z.object({
  payload: z.object({
    order_id: z.string().nullable().optional(),
    shipment_id: z.string().nullable().optional(),
    return_id: z.string().nullable().optional(),
    awb_code: z.string().nullable().optional(),
    courier_company_id: z.string().nullable().optional(),
    courier_name: z.string().nullable().optional(),
    label_url: z.string().nullable().optional(),
    charges: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
});

export const ratesSchema = z.object({
  result: z.object({
    serviceable_couriers: z.array(z.object({
      carrier_id: z.string(),
      carrier_name: z.string(),
      service_level: z.string().optional(),
      expected_delivery: z.object({ pickup: z.string(), delivery: z.string() }).optional(),
      charges: z.record(z.string(), z.unknown()),
      platform_fee: z.number().optional(),
    }).passthrough()),
    shipment_details: z.record(z.string(), z.unknown()),
  }),
});

export const packageSchema = z.object({
  length: z.number().finite().positive().max(1000),
  width: z.number().finite().positive().max(1000),
  height: z.number().finite().positive().max(1000),
  weightGrams: z.number().finite().positive().max(1_000_000),
});

const pincode = z.string().regex(/^[1-9][0-9]{5}$/);
export const serviceabilitySchema = z.object({
  from: pincode, to: pincode, payment_mode: z.enum(["prepaid", "cod"]),
  shipment_type: z.enum(["forward", "return"]),
}).strict();
export const serviceabilityResultSchema = z.object({
  result: z.object({ serviceability_results: z.array(z.object({ carrier_id: z.string(), carrier_name: z.string() }).passthrough()) }).passthrough(),
});
export const laneRateSchema = packageSchema.extend({
  origin: pincode, destination: pincode, journey: z.enum(["forward", "return"]),
  paymentMode: z.enum(["prepaid", "cod"]), codAmount: z.number().finite().nonnegative().max(10_000_000).default(0),
  qcApplicable: z.boolean().default(true),
}).strict().refine((data) => data.journey !== "forward" || data.paymentMode !== "cod" || data.codAmount > 0, "COD shipment value must be positive.");

const filterText = z.string().max(200);
const filterList = z.array(filterText).max(100);
const count = z.number().int().nonnegative();
const timestamp = z.number().int().nonnegative();
const pagination = {
  page: z.number().int().min(1).max(100_000).default(1),
  per_page: z.number().int().min(1).max(100).default(25),
  search: filterText.optional(), status: filterText.optional(),
  sort_order: z.enum(["asc", "desc"]).default("desc"),
};
export const forwardFilterSchema = z.object({
  ...pagination,
  date_field: z.enum(["order_date", "created_at", "ready_for_pickup_at", "delivered_at", "expected_delivery_date_at", "original_expected_delivery_date_at", "ndr_raised_at", "in_transit_at"]).optional(),
  start_time: timestamp.optional(), end_time: timestamp.optional(),
  granular_status: filterList.optional(), sub_status: filterList.optional(),
  carrier_id: filterList.optional(), external_carrier_id: filterList.optional(),
  carrier_group_id: filterList.optional(), external_carrier_group_id: filterList.optional(),
  warehouse_ids: filterList.optional(), channel: filterList.optional(), store_name: filterList.optional(), zone: filterList.optional(),
  is_cod: z.boolean().optional(), is_dangerous_goods: z.boolean().optional(), express: z.boolean().optional(),
  label_generated: z.boolean().optional(), manifested: z.boolean().optional(),
  pickup_id: filterText.optional(), order_display_id: filterList.optional(), sku: filterList.optional(),
  tags: filterList.optional(), ai_tags: filterList.optional(), ops_tags: filterList.optional(),
  city: filterText.optional(), rto_risk: filterText.optional(), address_validity: filterList.optional(),
  call_status: filterList.optional(), ndr_reason: filterList.optional(), rto_reason: filterList.optional(),
  needs_attention_issue: filterList.optional(), oc_all_outcomes: filterList.optional(),
  ndr_all_outcomes: filterList.optional(), cod_to_prepaid: filterList.optional(),
  items_count: count.optional(), items_count__gt: count.optional(), skus_count: count.optional(), skus_count__gt: count.optional(),
  applied_weight_min: z.number().finite().nonnegative().optional(), applied_weight_max: z.number().finite().nonnegative().optional(),
  attempts_count__gte: count.optional(), attempts_count__lte: count.optional(),
  original_expected_delivery_date_at__gte: timestamp.optional(), original_expected_delivery_date_at__lte: timestamp.optional(),
  external_id__matchs: filterText.optional(),
}).strict().refine((data) => data.start_time === undefined || data.end_time === undefined || data.end_time >= data.start_time, "End date must be after start date.");
export const returnFilterSchema = z.object({
  ...pagination, sort_by: z.enum(["created_at", "return_pickup_scheduled_at", "return_delivered_at", "return_cancelled_at"]).optional(),
  granular_status: filterList.optional(), sub_status: filterList.optional(), warehouse_id: filterList.optional(),
  channel: filterList.optional(), store_name: filterList.optional(), carrier_ids: filterList.optional(),
  carrier_group_id: filterList.optional(), zone: filterList.optional(), refund_status: filterList.optional(),
  qc_status: filterList.optional(), display_id: filterList.optional(), sku: filterList.optional(),
  is_dangerous_goods: z.boolean().optional(), skus_count: count.optional(), skus_count__gt: count.optional(),
  created_at__gte: z.iso.datetime().optional(), created_at__lte: z.iso.datetime().optional(),
  return_pickup_scheduled_at__gte: z.iso.datetime().optional(), return_pickup_scheduled_at__lte: z.iso.datetime().optional(),
  return_delivered_at__gte: z.iso.datetime().optional(), return_delivered_at__lte: z.iso.datetime().optional(),
  return_cancelled_at__gte: z.iso.datetime().optional(), return_cancelled_at__lte: z.iso.datetime().optional(),
}).strict();
export const remoteListResultSchema = z.object({
  data: z.array(z.object({ id: z.string(), attributes: z.record(z.string(), z.unknown()) }).passthrough()),
}).passthrough();

export function rateBody(
  parcel: z.infer<typeof packageSchema>,
  origin: string,
  destination: string,
  journey: "forward" | "return",
  codAmount = 0,
  qcApplicable = true,
) {
  packageSchema.parse(parcel);
  return {
    journey_type: journey, origin_pincode: origin, destination_pincode: destination,
    dead_weight: parcel.weightGrams, length: parcel.length, width: parcel.width, height: parcel.height,
    ...(journey === "return" ? { qc_applicable: qcApplicable } : {
      payment_method: codAmount > 0 ? "cod" : "prepaid",
      ...(codAmount > 0 ? { shipment_value: codAmount } : {}),
    }),
  };
}

export function codAllocation(
  payable: number,
  items: { id: string; unitPrice: number; quantity: number }[],
  itemId: string,
) {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const total = sorted.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  if (total <= 0) throw new HttpError(409, "Cannot allocate COD across order lines with no value.");
  let cumulative = 0;
  let assigned = 0;
  for (const item of sorted) {
    cumulative += item.unitPrice * item.quantity;
    const target = Math.round(payable * 100 * cumulative / total);
    const cents = target - assigned;
    assigned = target;
    if (item.id === itemId) return cents / 100;
  }
  throw new HttpError(404, "COD order line not found.");
}
