import { prisma } from "../lib/db";
import { badRequest } from "../lib/http";

const VALID_PAYMENT = ["paid", "cod", "refunded"];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const IST_OFFSET = 330 * 60_000;
const MAX_RANGE_DAYS = 366;
const MAX_ORDERS = 20_000;

type OrderRow = {
  createdAt: Date; payable: number; giftCardAmount: number; creditUsed: number; refunded: number; discount: number; shipping: number;
  coupon: string | null; customerId: string; address: unknown;
  items: { productId: string | null; title: string; quantity: number; unitPrice: number; status: string }[];
};

const round = (value: number) => Math.round(value * 100) / 100;
// What the customer was charged in total, including the parts covered by gift cards or store credit.
const orderTotal = (order: OrderRow) => order.payable + order.giftCardAmount + order.creditUsed;

async function loadOrders(from: Date, to: Date): Promise<OrderRow[]> {
  return prisma.order.findMany({
    where: { createdAt: { gte: from, lt: to }, paymentStatus: { in: VALID_PAYMENT } },
    select: {
      createdAt: true, payable: true, giftCardAmount: true, creditUsed: true, refunded: true, discount: true, shipping: true,
      coupon: true, customerId: true, address: true,
      items: { select: { productId: true, title: true, quantity: true, unitPrice: true, status: true } },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_ORDERS,
  });
}

function totals(orders: OrderRow[]) {
  const gross = orders.reduce((sum, order) => sum + orderTotal(order), 0);
  const refunds = orders.reduce((sum, order) => sum + order.refunded, 0);
  const units = orders.reduce((sum, order) => sum + order.items.filter((item) => item.status !== "cancelled").reduce((inner, item) => inner + item.quantity, 0), 0);
  const sales = gross - refunds;
  return {
    sales: round(sales),
    orders: orders.length,
    averageOrderValue: orders.length ? round(sales / orders.length) : 0,
    units,
    discounts: round(orders.reduce((sum, order) => sum + order.discount, 0)),
    shipping: round(orders.reduce((sum, order) => sum + order.shipping, 0)),
    refunds: round(refunds),
  };
}

export async function analyticsOverview(from: Date, to: Date) {
  const length = to.getTime() - from.getTime();
  if (!(length > 0)) throw badRequest("The end date must be after the start date");
  if (length > MAX_RANGE_DAYS * DAY) throw badRequest(`Choose a range of at most ${MAX_RANGE_DAYS} days`);

  const previousFrom = new Date(from.getTime() - length);
  const [orders, previousOrders] = await Promise.all([loadOrders(from, to), loadOrders(previousFrom, from)]);

  // Short ranges are shown hour by hour, longer ones day by day (aligned to Indian midnight).
  const step = length <= 2 * DAY ? HOUR : DAY;
  const start = Math.floor((from.getTime() + IST_OFFSET) / step) * step - IST_OFFSET;
  const count = Math.max(1, Math.ceil((to.getTime() - start) / step));
  const series = Array.from({ length: count }, (_, index) => ({ at: start + index * step, sales: 0, orders: 0, previousSales: 0 }));
  for (const order of orders) {
    const bucket = series[Math.floor((order.createdAt.getTime() - start) / step)];
    if (bucket) { bucket.sales += orderTotal(order) - order.refunded; bucket.orders += 1; }
  }
  for (const order of previousOrders) {
    const bucket = series[Math.floor((order.createdAt.getTime() + length - start) / step)];
    if (bucket) bucket.previousSales += orderTotal(order) - order.refunded;
  }

  const products = new Map<string, { title: string; units: number; sales: number }>();
  const cities = new Map<string, { city: string; orders: number; sales: number }>();
  const codes = new Map<string, { code: string; orders: number; discount: number; sales: number }>();
  for (const order of orders) {
    for (const item of order.items) {
      if (item.status === "cancelled" || item.status === "pending_payment") continue;
      const key = item.productId ?? item.title;
      const row = products.get(key) ?? { title: item.title, units: 0, sales: 0 };
      row.units += item.quantity;
      row.sales += item.unitPrice * item.quantity;
      products.set(key, row);
    }
    const rawCity = (order.address as { city?: unknown } | null)?.city;
    const city = typeof rawCity === "string" && rawCity.trim() ? rawCity.trim() : "Unknown";
    const cityRow = cities.get(city.toLowerCase()) ?? { city, orders: 0, sales: 0 };
    cityRow.orders += 1;
    cityRow.sales += orderTotal(order) - order.refunded;
    cities.set(city.toLowerCase(), cityRow);
    if (order.coupon) {
      const code = order.coupon.toUpperCase();
      const codeRow = codes.get(code) ?? { code, orders: 0, discount: 0, sales: 0 };
      codeRow.orders += 1;
      codeRow.discount += order.discount;
      codeRow.sales += orderTotal(order) - order.refunded;
      codes.set(code, codeRow);
    }
  }

  // A customer is "returning" when their first ever paid order is before this period.
  const customerIds = [...new Set(orders.map((order) => order.customerId))];
  const firstOrders = customerIds.length
    ? await prisma.order.groupBy({ by: ["customerId"], _min: { createdAt: true }, where: { customerId: { in: customerIds }, paymentStatus: { in: VALID_PAYMENT } } })
    : [];
  const returningIds = new Set(firstOrders.filter((row) => row._min.createdAt && row._min.createdAt < from).map((row) => row.customerId));
  const segment = (returning: boolean) => {
    const rows = orders.filter((order) => returningIds.has(order.customerId) === returning);
    return {
      customers: new Set(rows.map((order) => order.customerId)).size,
      orders: rows.length,
      sales: round(rows.reduce((sum, order) => sum + orderTotal(order) - order.refunded, 0)),
    };
  };

  const top = <T,>(map: Map<string, T>, by: (row: T) => number, limit: number) => [...map.values()].sort((a, b) => by(b) - by(a)).slice(0, limit);
  return {
    range: { from, to, step: step === HOUR ? "hour" : "day" },
    current: totals(orders),
    previous: totals(previousOrders),
    series: series.map((bucket) => ({ at: bucket.at, sales: round(bucket.sales), orders: bucket.orders, previousSales: round(bucket.previousSales) })),
    topProducts: top(products, (row) => row.sales, 10).map((row) => ({ ...row, sales: round(row.sales) })),
    salesByCity: top(cities, (row) => row.sales, 10).map((row) => ({ ...row, sales: round(row.sales) })),
    discountUsage: top(codes, (row) => row.orders, 10).map((row) => ({ ...row, discount: round(row.discount), sales: round(row.sales) })),
    customers: { new: segment(false), returning: segment(true) },
    truncated: orders.length >= MAX_ORDERS,
  };
}
