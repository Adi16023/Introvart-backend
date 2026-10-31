import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import type { Admin, Order, OrderItem, ShippingShipment } from "@prisma/client";
import { z } from "zod";
import { buildApp } from "../src/app";
import { prisma, type Tx } from "../src/lib/db";
import { env } from "../src/lib/env";
import { HttpError } from "../src/lib/http";
import { assignShipment, bookingSchema, bookShipment, cancelAwbs, cancelShipment, customerTracking, ensureDispatchAwb, reconcileShipping, refreshShipment, saveWarehouse, shippingLabel, shippingLine } from "../src/services/shipping";
import { cancelOrder } from "../src/services/orders";
import { decideReturn } from "../src/services/returns";
import { issueStaffToken } from "../src/services/staff-auth";
import { codAllocation, forwardFilterSchema, laneRateSchema, packageSchema, rateBody, ratesSchema, returnFilterSchema, serviceabilitySchema, velocityRequest } from "../src/services/velocity";
import { assignRemoteOrder, localShippingOrders, orderTab, quoteRemoteOrder, remoteRateBody } from "../src/services/shipping-orders";

test("Velocity integration uses mocks only; no live shipping or database calls", async (t) => {
  function stub(target: object, name: string, implementation: (...args: never[]) => unknown) {
    const original: unknown = Reflect.get(target, name);
    Object.defineProperty(target, name, { value: implementation, configurable: true, writable: true });
    t.after(() => { Object.defineProperty(target, name, { value: original, configurable: true, writable: true }); });
  }
  const previous = { ...env.velocity };
  env.velocity.apiKey = "mock-velocity-key";
  env.velocity.baseUrl = "https://shazam.velocity.in";
  t.after(() => { Object.assign(env.velocity, previous); });
  const shipments = new Map<string, ShippingShipment>();
  const calls: { endpoint: string; body: Record<string, unknown> }[] = [];
  let remote: (endpoint: string, body: Record<string, unknown>) => unknown = () => { throw new Error("No remote mock configured"); };
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return originalFetch(input, init);
    assert.ok(url.startsWith("https://shazam.velocity.in/custom/api/v1/"), "Unexpected network call");
    const endpoint = url.split("/").at(-1)!;
    assert.equal(new Headers(init?.headers).get("Authorization"), "mock-velocity-key");
    const body = JSON.parse(String(init?.body));
    calls.push({ endpoint, body });
    const result = remote(endpoint, body);
    return result instanceof Response ? result : Response.json(result);
  });

  const item: OrderItem = {
    id: "item-1", orderId: "order-1", productId: null, variantId: null, sku: "PRINT-1",
    title: "Test print", artistName: "Test artist", image: "", fulfilment: "platform_pod",
    sizeLabel: "A3", materialLabel: "Matte", frameLabel: "None", quantity: 2, unitPrice: 500,
    status: "packed", gift: false, giftMessage: "", creatorId: "artist-1", personalization: null,
    awb: null, deliveredAt: null,
  };
  const order: Order & { items: OrderItem[] } = {
    id: "order-1", ownerId: "guest:guest-1", customerId: "guest", customerName: "Test shopper",
    email: "shopper@example.test", placedAt: "31 Oct 2026", createdAt: new Date(),
    address: { name: "Test shopper", phone: "9999999999", line: "Test street", city: "Delhi", state: "Delhi", pincode: "110001" },
    delivery: "standard", paymentMethod: "COD", paymentStatus: "cod", coupon: null, discount: 0,
    shipping: 149, giftCardCode: null, giftCardAmount: 0, creditUsed: 0, subtotal: 1000, gst: 0,
    payable: 1149, refunded: 0, gstInvoice: true, stockReserved: true, settled: true, shippingBlocked: false, gatewayPaymentId: null, items: [item],
  };
  const warehouse = {
    id: "warehouse-1", owner: "platform", velocityId: "VELOCITY-WH", name: "Test warehouse",
    contactPerson: "Test staff", phone: "9999999999", email: "warehouse@example.test",
    address: "Test warehouse street", city: "Mumbai", state: "Maharashtra", pincode: "400001",
    createdAt: new Date(), updatedAt: new Date(),
  };
  let jobStatus = "ready";
  let replacement = false;
  let returnStatus = "pickup_approved";
  const itemUpdates: Record<string, unknown>[] = [];
  const jobUpdates: Record<string, unknown>[] = [];
  const shipmentQueries: unknown[] = [];
  const remoteAssignments = new Map<string, { shipmentId: string; state: string; carrierId: string; awb?: string; error?: string; result?: unknown }>();
  stub(prisma.velocityAssignment, "findUnique", async ({ where }: { where: { shipmentId: string } }) => remoteAssignments.get(where.shipmentId) ?? null);
  stub(prisma.velocityAssignment, "findMany", async () => [...remoteAssignments.values()]);
  stub(prisma.velocityAssignment, "createMany", async ({ data }: { data: { shipmentId: string; state: string; carrierId: string }[] }) => {
    if (remoteAssignments.has(data[0].shipmentId)) return { count: 0 };
    remoteAssignments.set(data[0].shipmentId, { ...data[0] }); return { count: 1 };
  });
  stub(prisma.velocityAssignment, "update", async ({ where, data }: { where: { shipmentId: string }; data: Record<string, unknown> }) => {
    const action = remoteAssignments.get(where.shipmentId); assert.ok(action); Object.assign(action, data); return action;
  });
  stub(prisma.order, "findUnique", async () => order);
  stub(prisma.orderItem, "findMany", async () => [{ ...item, order: { ...order, shipments: [...shipments.values()].filter(row => row.journey === "forward"), jobs: [{ id: "job-1", itemId: item.id, status: jobStatus }] } }]);
  stub(prisma.productVariant, "findMany", async () => []);
  stub(prisma.order, "updateMany", async () => ({ count: 1 }));
  stub(prisma.order, "update", async ({ data }: { data: Partial<Order> }) => { Object.assign(order, data); return order; });
  stub(prisma.orderItem, "findUnique", async () => item);
  stub(prisma.orderItem, "findFirst", async () => item);
  stub(prisma.orderItem, "count", async () => 0);
  stub(prisma.orderItem, "update", async ({ data }: { data: Record<string, unknown> }) => {
    itemUpdates.push(data); Object.assign(item, data); return item;
  });
  stub(prisma.orderItem, "updateMany", async ({ data }: { data: Record<string, unknown> }) => {
    itemUpdates.push(data); Object.assign(item, data); return { count: 1 };
  });
  stub(prisma.printJob, "findUnique", async () => ({ id: "job-1", orderId: order.id, itemId: item.id, status: jobStatus, awb: null }));
  stub(prisma.printJob, "count", async () => replacement ? 1 : 0);
  stub(prisma.printJob, "update", async ({ data }: { data: Record<string, unknown> }) => { jobUpdates.push(data); return data; });
  stub(prisma.printJob, "updateMany", async ({ data }: { data: Record<string, unknown> }) => { jobUpdates.push(data); return { count: 1 }; });
  stub(prisma.shippingWarehouse, "findUnique", async () => warehouse);
  stub(prisma.shippingWarehouse, "findMany", async () => [warehouse]);
  stub(prisma.shippingWarehouse, "upsert", async ({ create }: { create: unknown }) => create);
  stub(prisma.shippingShipment, "findUnique", async ({ where }: { where: { id?: string; bookingKey?: string } }) =>
    [...shipments.values()].find((row) => where.id ? row.id === where.id : row.bookingKey === where.bookingKey) ?? null);
  stub(prisma.shippingShipment, "findUniqueOrThrow", async ({ where }: { where: { id: string } }) => {
    const row = shipments.get(where.id); assert.ok(row); return row;
  });
  stub(prisma.shippingShipment, "findFirst", async ({ where }: { where: { itemId?: string; returnCaseId?: string; journey?: string; state?: { not: string }; jobId?: string; remoteShipmentId?: string } }) =>
    [...shipments.values()].find((row) => (!where.itemId || row.itemId === where.itemId) &&
      (!where.returnCaseId || row.returnCaseId === where.returnCaseId) && (!where.journey || row.journey === where.journey) &&
      (!where.state || row.state !== where.state.not) && (!where.jobId || row.jobId === where.jobId) && (!where.remoteShipmentId || row.remoteShipmentId === where.remoteShipmentId)) ?? null);
  stub(prisma.shippingShipment, "count", async () => [...shipments.values()].filter((row) => row.state !== "cancelled").length);
  stub(prisma.shippingShipment, "findMany", async (query: unknown) => { shipmentQueries.push(query); return [...shipments.values()]; });
  stub(prisma.shippingShipment, "create", async ({ data }: { data: Partial<ShippingShipment> & Pick<ShippingShipment, "id" | "bookingKey" | "orderId" | "itemId" | "warehouseId" | "journey" | "length" | "width" | "height" | "weightGrams" | "request"> }) => {
    if ([...shipments.values()].some((row) => row.bookingKey === data.bookingKey)) throw new Error("Duplicate booking key");
    const row: ShippingShipment = {
      state: "creating", status: "pending", jobId: null, returnCaseId: null, creatorId: null,
      remoteOrderId: null, remoteShipmentId: null, remoteReturnId: null, awb: null, carrierId: null, carrierName: null,
      labelUrl: null, labelKey: null, trackingUrl: null, codAmount: 0, charges: {}, tracking: [],
      error: null, syncedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data,
    };
    shipments.set(row.id, row); return row;
  });
  stub(prisma.shippingShipment, "update", async ({ where, data }: { where: { id: string }; data: Partial<ShippingShipment> }) => {
    const row = shipments.get(where.id); assert.ok(row);
    Object.assign(row, data); row.updatedAt = new Date(); return row;
  });
  stub(prisma.shippingShipment, "updateMany", async ({ where, data }: {
    where: { id?: string; state?: string | { not: string }; awb?: null | { in: string[] } }; data: Partial<ShippingShipment>;
  }) => {
    let count = 0;
    for (const row of shipments.values()) {
      if (where.id && row.id !== where.id) continue;
      if (typeof where.state === "string" && row.state !== where.state) continue;
      if (typeof where.state === "object" && row.state === where.state.not) continue;
      if (where.awb === null && row.awb !== null) continue;
      if (where.awb && (!row.awb || !where.awb.in.includes(row.awb))) continue;
      Object.assign(row, data); count++;
    }
    return { count };
  });
  const returnRecord = () => ({ id: "return-1", orderId: order.id, itemId: item.id, itemTitle: item.title, status: returnStatus, order });
  stub(prisma.returns, "findUnique", async () => returnRecord());
  stub(prisma.returns, "findUniqueOrThrow", async () => returnRecord());
  stub(prisma.returns, "update", async ({ data }: { data: { status: string } }) => { returnStatus = data.status; return returnRecord(); });
  stub(prisma.returns, "updateMany", async ({ data }: { data: { status: string } }) => { returnStatus = data.status; return { count: 1 }; });
  stub(prisma, "$transaction", async (work: (tx: Tx) => Promise<unknown>) => work(prisma));
  stub(prisma, "$queryRaw", async () => []);
  stub(prisma.activity, "create", async () => ({}));
  t.after(async () => { await prisma.$disconnect(); });

  const parcel = { itemId: item.id, jobId: "job-1", length: 30, width: 20, height: 5, weightGrams: 750 };
  const rates = { status: "SUCCESS", result: {
    serviceable_couriers: [{
      carrier_id: "carrier-1", carrier_name: "Test carrier", carrier_code: "TEST",
      service_level: "standard", is_fast: false, is_prime: false, status: "active",
      expected_delivery: { pickup: "2026-10-31", delivery: "2026-11-03" },
      charges: { forward_freight_charges: 85, cod_charges: 25, rto_charges: 85, total_forward_charges: 110 },
      platform_fee: 5,
    }],
    shipment_details: {
      journey_type: "forward", origin_pincode: "400001", destination_pincode: "110001",
      payment_method: "cod", dead_weight: 750, volumetric_weight: 1500, applicable_weight: 1500, zone: "B",
    },
  } };
  function bookingMock(endpoint: string) {
    if (endpoint === "rates") return rates;
    if (endpoint === "forward-order") return { status: 1, payload: { order_id: "remote-order", shipment_id: "remote-shipment" } };
    if (endpoint === "forward-order-shipment") return { status: 1, payload: { awb_code: "TEST-AWB", shipment_id: "remote-shipment", courier_name: "Test carrier" } };
    if (endpoint === "reverse-order") return { status: 1, payload: { order_id: "remote-order", return_id: "remote-return" } };
    if (endpoint === "reverse-order-shipment") return { status: 1, payload: { awb_code: "TEST-RETURN", shipment_id: "remote-return-shipment" } };
    throw new Error(`Unmocked ${endpoint}`);
  }
  function trackingMock(status: string) {
    return { result: Object.fromEntries([...shipments.values()].filter((row) => row.awb).map((row) => [row.awb, {
      tracking_data: { shipment_status: status, track_url: `https://shipfastt.in/track/${row.awb}`, shipment_track_activities: [{ date: "2026-10-31 12:00:00", activity: status, location: "Delhi" }] },
    }])) };
  }

  await t.test("rates use grams, cm, lower-case payment modes and the documented return QC default", async () => {
    assert.equal(rateBody(parcel, "400001", "110001", "forward", 1149).dead_weight, 750);
    assert.equal(rateBody(parcel, "400001", "110001", "forward", 1149).payment_method, "cod");
    assert.equal(rateBody(parcel, "110001", "400001", "return").qc_applicable, true);
    assert.equal(rateBody(parcel, "110001", "400001", "return", 0, false).qc_applicable, false);
    assert.equal(packageSchema.safeParse({ ...parcel, height: 0 }).success, false);
    assert.equal(packageSchema.safeParse({ ...parcel, weightGrams: Infinity }).success, false);
  });
  await t.test("COD allocations add up exactly across multi-artist order lines", () => {
    const lines = [{ id: "a", unitPrice: 100, quantity: 1 }, { id: "b", unitPrice: 100, quantity: 1 }, { id: "c", unitPrice: 100, quantity: 1 }];
    assert.equal(lines.reduce((sum, line) => sum + Math.round(codAllocation(100.01, lines, line.id) * 100), 0), 10001);
    assert.throws(() => codAllocation(10, [], "missing"), /no value/);
  });
  await t.test("rates retain object estimates and accept unavailable estimates without weakening courier validation", async () => {
    const courier = rates.result.serviceable_couriers[0];
    const estimate = {
      pickup: { date: "2026-10-31T12:00:00+05:30", timezone: "Asia/Kolkata" },
      delivery: { minimum_days: 2, maximum_days: 4 },
    };
    remote = () => ({ ...rates, result: { ...rates.result, serviceable_couriers: [
      { ...courier, expected_delivery: estimate },
      { ...courier, carrier_id: "carrier-2", expected_delivery: { pickup: null } },
      { ...courier, carrier_id: "carrier-3", expected_delivery: null },
      courier,
    ] } });
    const parsed = await velocityRequest("rates", {}, ratesSchema);
    assert.deepEqual(parsed.result.serviceable_couriers[0].expected_delivery, estimate);
    assert.deepEqual(parsed.result.serviceable_couriers[1].expected_delivery, { pickup: null });
    assert.equal(parsed.result.serviceable_couriers[2].expected_delivery, null);
    assert.deepEqual(parsed.result.serviceable_couriers[3].expected_delivery, courier.expected_delivery);
    for (const expected_delivery of [{ pickup: [] }, { delivery: true }]) {
      assert.equal(ratesSchema.safeParse({ ...rates, result: { ...rates.result, serviceable_couriers: [{ ...courier, expected_delivery }] } }).success, false);
    }
    assert.equal(ratesSchema.safeParse({ ...rates, result: { ...rates.result, serviceable_couriers: [{ ...courier, carrier_id: null }] } }).success, false);
    assert.equal(ratesSchema.safeParse({ ...rates, result: { ...rates.result, serviceable_couriers: [{ ...courier, charges: null }] } }).success, false);
  });
  await t.test("client rejects auth failures, malformed JSON and business failures without exposing credentials", async () => {
    remote = () => new Response("", { status: 401 });
    await assert.rejects(velocityRequest("rates", {}, ratesSchema), /rejected the API key/);
    remote = () => new Response("not-json", { status: 200 });
    await assert.rejects(velocityRequest("rates", {}, ratesSchema), /invalid JSON/);
    remote = () => ({ status: 0, payload: {} });
    await assert.rejects(velocityRequest("rates", {}, ratesSchema), /operation failure/);
    remote = () => ({ status: "SUCCESS", result: {} });
    await assert.rejects(velocityRequest("rates", {}, ratesSchema), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.match(error.message, /unexpected response.*result/);
      assert.match(JSON.stringify(error.details), /"path":"result\.serviceable_couriers"/);
      assert.match(JSON.stringify(error.details), /"path":"result\.shipment_details"/);
      return true;
    });
  });
  await t.test("client rejects unknown hosts and missing keys before network requests", async () => {
    const count = calls.length;
    env.velocity.baseUrl = "http://localhost";
    await assert.rejects(velocityRequest("reports", {}, z.unknown()), /confirmed/);
    env.velocity.baseUrl = "https://shazam.velocity.in";
    env.velocity.apiKey = "";
    await assert.rejects(velocityRequest("reports", {}, z.unknown()), /not configured/);
    env.velocity.apiKey = "mock-velocity-key";
    assert.equal(calls.length, count);
  });
  await t.test("linking an existing warehouse performs no Velocity mutation", async () => {
    const count = calls.length;
    const saved = await saveWarehouse("platform", { ...warehouse, velocityId: "EXISTING-WH" });
    assert.equal(saved.velocityId, "EXISTING-WH");
    assert.equal(calls.length, count);
  });
  await t.test("creator cannot quote or book another artist or a platform print", async () => {
    await assert.rejects(shippingLine(order.id, item.id, { creatorId: "artist-1" }), /not found/);
    item.fulfilment = "original";
    await assert.rejects(shippingLine(order.id, item.id, { creatorId: "artist-other" }), /not found/);
    item.fulfilment = "platform_pod";
  });
  await t.test("unpaid orders and unfinished print jobs never reach Velocity", async () => {
    const count = calls.length;
    order.paymentStatus = "pending";
    await assert.rejects(bookShipment(order.id, parcel, {}), /paid/);
    order.paymentStatus = "cod";
    jobStatus = "printing";
    await assert.rejects(bookShipment(order.id, parcel, {}), /mark this job ready/);
    jobStatus = "ready";
    assert.equal(calls.length, count);
  });
  await t.test("an order cancellation claim blocks reservation before remote booking", async () => {
    remote = bookingMock; calls.length = 0; order.shippingBlocked = true;
    await assert.rejects(bookShipment(order.id, parcel, {}), /being cancelled/);
    assert.deepEqual(calls.map((call) => call.endpoint), ["rates"]);
    assert.equal(shipments.size, 0);
    order.shippingBlocked = false;
  });
  await t.test("an unsupported carrier cannot create a shipment", async () => {
    calls.length = 0; remote = bookingMock;
    await assert.rejects(bookShipment(order.id, { ...parcel, carrierId: "unknown" }, {}), /current quote/);
    assert.equal(shipments.size, 0);
    assert.deepEqual(calls.map((call) => call.endpoint), ["rates"]);
  });
  await t.test("forward booking persists IDs and real AWB but does not dispatch before pickup", async () => {
    calls.length = 0; remote = bookingMock;
    const result = await bookShipment(order.id, parcel, {});
    assert.equal(result.state, "booked");
    assert.equal(result.awb, "TEST-AWB");
    assert.equal(result.codAmount, 1149);
    assert.equal("request" in result, false);
    assert.equal("labelKey" in result, false);
    assert.deepEqual(calls.map((call) => call.endpoint), ["rates", "forward-order", "forward-order-shipment"]);
    assert.equal(calls[1].body.weight, 0.75);
    assert.equal(calls[1].body.breadth, 20);
    assert.equal(calls[1].body.payment_method, "COD");
    assert.equal(item.status, "packed");
  });
  await t.test("repeated booking returns the persisted shipment without calling Velocity again", async () => {
    const count = calls.length;
    await bookShipment(order.id, parcel, {});
    assert.equal(calls.length, count);
  });
  await t.test("Velocity AWB cannot be overwritten by a manual dispatch", async () => {
    await assert.rejects(ensureDispatchAwb(item.id, "job-1", "FAKE-AWB"), /assigned by Velocity/);
    assert.equal(await ensureDispatchAwb(item.id, "job-1"), "TEST-AWB");
  });
  await t.test("tracking marks pickup as dispatch and delivery as delivered", async () => {
    const shipment = [...shipments.values()][0];
    remote = () => trackingMock("in_transit");
    await refreshShipment(shipment.id, {});
    assert.equal(item.status, "shipped");
    assert.ok(jobUpdates.some((update) => update.status === "dispatched"));
    remote = () => trackingMock("delivered");
    await refreshShipment(shipment.id, {});
    assert.equal(item.status, "delivered");
    assert.ok(item.deliveredAt);
    item.status = "packed";
    item.deliveredAt = null;
  });
  await t.test("order cancellation is blocked before any refund when a live shipment exists", async () => {
    const previousStatus = item.status;
    item.status = "confirmed";
    await assert.rejects(cancelOrder(order.id), /Cancel Velocity/);
    item.status = previousStatus;
  });
  await t.test("cancellation is asynchronous and a new booking is allowed only after confirmation", async () => {
    const shipment = [...shipments.values()][0];
    remote = (endpoint) => endpoint === "cancel-order" ? { message: "Cancellation in progress" } : trackingMock("ready_for_pickup");
    const result = await cancelShipment(shipment.id, {});
    assert.equal(result.state, "cancel_requested");
    assert.equal(result.status, "ready_for_pickup");
    remote = () => trackingMock("cancelled");
    await refreshShipment(shipment.id, {});
    assert.equal(shipment.state, "cancelled");
    assert.notEqual(shipment.bookingKey, "job:job-1");
  });
  await t.test("ambiguous timeout retains a reference and does not allow blind duplicate retries", async () => {
    shipments.clear();
    remote = (endpoint) => endpoint === "rates" ? rates : (() => { throw new Error("Mock timeout"); })();
    await assert.rejects(bookShipment(order.id, parcel, {}), /did not respond/);
    const shipment = [...shipments.values()][0];
    assert.equal(shipment.state, "attention");
    const count = calls.length;
    await assert.rejects(bookShipment(order.id, parcel, {}), /already exists/);
    assert.equal(calls.length, count);
  });
  await t.test("reconciliation matches exact external reference rather than a fuzzy search hit", async () => {
    const shipment = [...shipments.values()][0];
    remote = () => ({ data: [{ id: "other", attributes: { tracking_number: "WRONG-AWB", status: "pending", order: { external_id: `${shipment.id}-other` } } }] });
    await assert.rejects(refreshShipment(shipment.id, {}), /Cannot uniquely reconcile/);
    assert.equal(shipment.awb, null);
    remote = (endpoint) => endpoint === "shipments"
      ? { data: [{ id: "remote-id", attributes: { tracking_number: "RECOVERED-AWB", status: "ready_for_pickup", order: { external_id: shipment.id } } }] }
      : trackingMock("ready_for_pickup");
    const recovered = await refreshShipment(shipment.id, {});
    assert.equal(recovered.awb, "RECOVERED-AWB");
  });
  await t.test("returns require approval, reverse warehouse/customer addresses, and do not collect COD", async () => {
    shipments.clear(); calls.length = 0; remote = bookingMock;
    returnStatus = "opened";
    await assert.rejects(bookShipment(order.id, { ...parcel, returnCaseId: "return-1" }, {}), /Approve/);
    returnStatus = "pickup_approved";
    const result = await bookShipment(order.id, { ...parcel, returnCaseId: "return-1" }, {});
    assert.equal(result.journey, "return");
    assert.equal(result.codAmount, 0);
    assert.deepEqual(calls.map((call) => call.endpoint), ["rates", "reverse-order", "reverse-order-shipment"]);
    assert.equal(calls[1].body.pickup_pincode, "110001");
    assert.equal(calls[1].body.shipping_pincode, "400001");
    assert.equal(calls[1].body.payment_method, "PREPAID");
    assert.equal(calls[2].body.return_id, "remote-return");
    await assert.rejects(decideReturn("return-1", "refunded"), /Wait for the physical return/);
  });
  await t.test("reverse delivered tracking is normalized without marking the outgoing item delivered", async () => {
    const shipment = [...shipments.values()][0];
    item.status = "return_requested";
    remote = () => trackingMock("delivered");
    const result = await refreshShipment(shipment.id, {});
    assert.equal(result.status, "return_delivered");
    assert.equal(item.status, "return_requested");
    assert.equal(shipment.status, "return_delivered");
  });
  await t.test("customer tracking excludes costs, addresses, label links and internal request data", async () => {
    const result = (await customerTracking(order.id))[0];
    assert.ok(result);
    for (const key of ["request", "charges", "codAmount", "labelUrl", "labelKey", "warehouseId", "creatorId"]) assert.equal(key in result, false);
  });
  await t.test("return resolution succeeds only after confirmed return delivery", async () => {
    const result = await decideReturn("return-1", "closed");
    assert.equal(result.status, "closed");
    assert.equal(item.status, "delivered");
    returnStatus = "pickup_approved";
  });
  await t.test("a persisted return-resolution claim prevents a new pickup or competing decision", async () => {
    shipments.clear(); calls.length = 0; returnStatus = "resolving";
    await assert.rejects(bookShipment(order.id, { ...parcel, returnCaseId: "return-1" }, {}), /Approve/);
    await assert.rejects(decideReturn("return-1", "pickup_approved"), /already resolving/);
    assert.equal(calls.length, 0);
    returnStatus = "pickup_approved";
  });
  await t.test("a resolution claim taken during quoting is rechecked before booking", async () => {
    calls.length = 0; remote = (endpoint) => {
      assert.equal(endpoint, "rates"); returnStatus = "resolving"; return rates;
    };
    await assert.rejects(bookShipment(order.id, { ...parcel, returnCaseId: "return-1" }, {}), /approval changed/);
    assert.equal(shipments.size, 0);
    assert.deepEqual(calls.map((call) => call.endpoint), ["rates"]);
    returnStatus = "pickup_approved";
  });
  await t.test("tracking polling prioritizes unsynced parcels without creating shipments", async () => {
    calls.length = 0;
    await reconcileShipping();
    assert.deepEqual(shipmentQueries.at(-1), {
      where: { awb: { not: null }, state: { in: ["booked", "cancel_requested", "attention"] }, status: { notIn: ["delivered", "return_delivered", "rto_delivered", "lost"] } },
      orderBy: { syncedAt: { sort: "asc", nulls: "first" } }, take: 25,
    });
    assert.equal(calls.length, 0);
  });
  await t.test("replacement print jobs do not collect original COD a second time", async () => {
    shipments.clear(); replacement = true; item.status = "in_production"; item.deliveredAt = new Date(); calls.length = 0; remote = bookingMock;
    const result = await bookShipment(order.id, parcel, {});
    assert.equal(result.codAmount, 0);
    assert.equal(calls[1].body.payment_method, "PREPAID");
    replacement = false;
  });
  await t.test("a QC-failed job before the first delivery still collects the original COD", async () => {
    shipments.clear(); replacement = true; item.deliveredAt = null; calls.length = 0; remote = bookingMock;
    const result = await bookShipment(order.id, parcel, {});
    assert.equal(result.codAmount, 1149);
    assert.equal(calls[1].body.payment_method, "COD");
    replacement = false;
  });
  await t.test("label storage failure retains the booked AWB and does not trigger a duplicate booking", async () => {
    shipments.clear(); calls.length = 0;
    remote = (endpoint) => endpoint === "forward-order-shipment"
      ? { status: 1, payload: { awb_code: "LABEL-AWB", shipment_id: "remote-shipment", label_url: "https://unsupported.example.test/label.pdf" } }
      : bookingMock(endpoint);
    const shipment = await bookShipment(order.id, parcel, {});
    assert.equal(shipment.state, "booked");
    assert.equal(shipment.awb, "LABEL-AWB");
    assert.match(shipment.error ?? "", /label storage failed/);
    await assert.rejects(shippingLabel(shipment.id, {}), /not supported/);
    const count = calls.length;
    await bookShipment(order.id, parcel, {});
    assert.equal(calls.length, count);
  });
  await t.test("documented filters and standalone lane tools reject invalid inputs", () => {
    assert.equal(serviceabilitySchema.safeParse({ from: "400001", to: "110001", payment_mode: "prepaid", shipment_type: "forward" }).success, true);
    assert.equal(serviceabilitySchema.safeParse({ from: "123", to: "110001", payment_mode: "prepaid", shipment_type: "forward" }).success, false);
    assert.equal(laneRateSchema.safeParse({ ...parcel, origin: "400001", destination: "110001", journey: "forward", paymentMode: "cod" }).success, false);
    assert.equal(forwardFilterSchema.safeParse({ page: 1, per_page: 101 }).success, false);
    assert.equal(forwardFilterSchema.safeParse({ page: 1, warehouse_ids: ["WH1"], is_cod: false, applied_weight_min: 500 }).success, true);
    assert.equal(forwardFilterSchema.safeParse({ arbitrary_endpoint: "forward-order" }).success, false);
    assert.equal(returnFilterSchema.safeParse({ qc_status: ["passed"], carrier_ids: ["CAR1"], created_at__gte: "2026-10-01T00:00:00Z" }).success, true);
    assert.equal(returnFilterSchema.safeParse({ created_at__gte: 1 }).success, false);
    assert.equal(returnFilterSchema.safeParse({ is_dangerous_goods: "false" }).success, false);
    assert.equal(bookingSchema.safeParse({ ...parcel, returnQc: { productName: "Art", image: "https://example.test/art.jpg", configured: true } }).success, false);
    assert.equal(bookingSchema.safeParse({ ...parcel, returnCaseId: "return-1", returnQc: { productName: "Art", image: "https://example.test/art.jpg", configured: false } }).success, false);
  });
  await t.test("forward orchestration books exactly one stable parcel without a second assignment", async () => {
    shipments.clear(); calls.length = 0; item.status = "packed"; item.deliveredAt = null;
    remote = (endpoint, body) => {
      if (endpoint === "rates") return rates;
      assert.equal(endpoint, "forward-order-orchestration");
      assert.equal(body.carrier_id, "carrier-1");
      assert.ok([...shipments.values()].some((row) => row.id === body.order_id));
      return { status: 1, payload: { order_id: "remote-order", shipment_id: "remote-shipment", awb_code: "ORCHESTRATED-AWB" } };
    };
    const result = await bookShipment(order.id, { ...parcel, bookingMode: "orchestration", carrierId: "carrier-1" }, {});
    assert.equal(result.state, "booked");
    assert.deepEqual(calls.map((entry) => entry.endpoint), ["rates", "forward-order-orchestration"]);
  });
  await t.test("create-only keeps a remote reference and later assignment does not recreate the order", async () => {
    shipments.clear(); calls.length = 0; remote = bookingMock;
    const created = await bookShipment(order.id, { ...parcel, bookingMode: "order_only" }, {});
    assert.equal(created.state, "order_created"); assert.equal(created.awb, null);
    assert.equal(created.remoteShipmentId, "remote-shipment");
    assert.deepEqual(calls.map((entry) => entry.endpoint), ["rates", "forward-order"]);
    const result = await assignShipment(created.id, "carrier-1", {});
    assert.equal(result.state, "booked"); assert.equal(result.awb, "TEST-AWB");
    assert.deepEqual(calls.map((entry) => entry.endpoint), ["rates", "forward-order", "rates", "forward-order-shipment"]);
    await assert.rejects(assignShipment(created.id, undefined, {}), /Only an unassigned/);
  });
  await t.test("deferred assignment times out into attention and cannot blindly retry", async () => {
    shipments.clear(); remote = bookingMock;
    const created = await bookShipment(order.id, { ...parcel, bookingMode: "order_only" }, {});
    remote = (endpoint) => endpoint === "rates" ? rates : (() => { throw new Error("Assignment timeout"); })();
    await assert.rejects(assignShipment(created.id, undefined, {}), /did not respond/);
    assert.equal(shipments.get(created.id)?.state, "attention");
    await assert.rejects(assignShipment(created.id, undefined, {}), /Only an unassigned/);
  });
  await t.test("competing deferred assignments make at most one remote assignment", async () => {
    shipments.clear(); remote = bookingMock;
    const created = await bookShipment(order.id, { ...parcel, bookingMode: "order_only" }, {});
    calls.length = 0;
    const results = await Promise.allSettled([assignShipment(created.id, undefined, {}), assignShipment(created.id, undefined, {})]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(calls.filter((entry) => entry.endpoint === "forward-order-shipment").length, 1);
  });
  await t.test("changing the remote warehouse prevents assigning an old order to a different origin", async () => {
    shipments.clear(); remote = bookingMock;
    const created = await bookShipment(order.id, { ...parcel, bookingMode: "order_only" }, {});
    warehouse.velocityId = "DIFFERENT-WH"; calls.length = 0;
    await assert.rejects(assignShipment(created.id, undefined, {}), /configuration changed/);
    assert.equal(calls.length, 0);
    assert.equal(shipments.get(created.id)?.state, "order_created");
    warehouse.velocityId = "VELOCITY-WH";
  });
  await t.test("QC reverse orchestration uses the documented endpoint and does not require return_id when AWB exists", async () => {
    shipments.clear(); calls.length = 0; returnStatus = "pickup_approved";
    remote = (endpoint, body) => {
      if (endpoint === "rates") { assert.equal(body.qc_applicable, true); return rates; }
      assert.equal(endpoint, "reverse-order-orchestration");
      assert.deepEqual(body.order_items, [{
        name: item.title, sku: item.sku, units: item.quantity, selling_price: item.unitPrice,
        qc_enable: true, qc_product_name: "Test print", qc_product_image: "https://example.test/art.jpg", qc_brand: "Test",
      }]);
      return { status: 1, payload: { order_id: "remote-return-order", shipment_id: "reverse-shipment", awb_code: "QC-AWB" } };
    };
    const result = await bookShipment(order.id, {
      ...parcel, returnCaseId: "return-1", bookingMode: "orchestration",
      returnQc: { productName: "Test print", image: "https://example.test/art.jpg", brand: "Test", configured: true },
    }, {});
    assert.equal(result.state, "booked"); assert.equal(result.codAmount, 0);
    assert.deepEqual(calls.map((entry) => entry.endpoint), ["rates", "reverse-order-orchestration"]);
  });
  await t.test("reverse create-only assignment uses the preserved return and warehouse IDs", async () => {
    shipments.clear(); remote = bookingMock; calls.length = 0;
    const created = await bookShipment(order.id, { ...parcel, returnCaseId: "return-1", bookingMode: "order_only" }, {});
    const result = await assignShipment(created.id, undefined, {});
    assert.equal(result.awb, "TEST-RETURN");
    assert.deepEqual(calls.at(-1)?.body, { return_id: "remote-return", warehouse_id: warehouse.velocityId, carrier_id: "" });
  });
  await t.test("bulk cancellation checks every AWB and persists pending rather than confirmed cancellation", async () => {
    const row = [...shipments.values()][0]; calls.length = 0;
    remote = (endpoint) => endpoint === "order-tracking" ? trackingMock("ready_for_pickup") : { message: "Cancellation requested" };
    await cancelAwbs([row.awb!, row.awb!]);
    assert.deepEqual(calls.at(-1)?.body, { awbs: [row.awb] });
    assert.equal(row.state, "cancel_requested");
    calls.length = 0; remote = () => trackingMock("delivered");
    await assert.rejects(cancelAwbs([row.awb!]), /No bulk cancellation was sent/);
    assert.deepEqual(calls.map((entry) => entry.endpoint), ["order-tracking"]);
  });
  await t.test("order status tabs preserve delivered, attention, RTO and cancelled distinctions", () => {
    assert.equal(orderTab("pending"), "new");
    assert.equal(orderTab("ready_for_pickup", "booked"), "ready");
    assert.equal(orderTab("out_for_delivery", "booked"), "transit");
    assert.equal(orderTab("delivered", "booked"), "delivered");
    assert.equal(orderTab("pending", "attention"), "attention");
    assert.equal(orderTab("ready_for_pickup", "cancel_requested"), "attention");
    assert.equal(orderTab("rto_delivered", "booked"), "rto");
    assert.equal(orderTab("cancelled", "cancelled"), "cancelled");
    assert.equal(orderTab("refunded", "attention"), "cancelled");
  });
  await t.test("local orders include customer, pickup and parcel history without leaking stored booking requests", async () => {
    const rows = await localShippingOrders();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customer.phone, "9999999999");
    assert.equal(rows[0].warehouse?.velocityId, "VELOCITY-WH");
    assert.equal(rows[0].quantity, 2);
    assert.ok(rows[0].shipments.every(row => !("request" in row) && !("labelKey" in row)));
  });
  await t.test("an unbooked replacement print job appears as new even when the original line was delivered", async () => {
    const previousStatus = item.status;
    const previousJob = jobStatus;
    item.status = "delivered"; jobStatus = "ready";
    try {
      const rows = await localShippingOrders();
      assert.equal(rows[0].tab, "new");
      assert.equal(rows[0].productionStatus, "ready");
      assert.equal(rows[0].ready, true);
    } finally { item.status = previousStatus; jobStatus = previousJob; }
  });
  await t.test("external quotes use authoritative Velocity addresses and COD, not client input", async () => {
    const attributes = { status: "new", tracking_number: null, pickup_details: { zip: "400001" }, shipping_address: { zip: "110001" }, is_cod: true, cod_amount: 1149 };
    remote = endpoint => {
      if (endpoint === "shipments") return { data: [{ id: "EXTERNAL-QUOTE", attributes }] };
      if (endpoint === "rates") return rates;
      throw new Error(`Unmocked ${endpoint}`);
    };
    calls.length = 0;
    assert.equal((await quoteRemoteOrder("EXTERNAL-QUOTE", parcel, "#1005")).serviceable_couriers.length, 1);
    assert.equal(calls[0].body.search, "#1005");
    assert.equal(calls[1].body.origin_pincode, "400001");
    assert.equal(calls[1].body.destination_pincode, "110001");
    assert.equal(calls[1].body.shipment_value, 1149);
    assert.equal(calls[1].body.dead_weight, 750);
    assert.throws(() => remoteRateBody({ ...attributes, pickup_details: {} }, parcel), /did not provide/);
    assert.throws(() => remoteRateBody({ ...attributes, is_cod: undefined }, parcel), /did not provide/);
    assert.throws(() => remoteRateBody({ ...attributes, weight: { value: 1, metric_unit: "kg" } }, parcel), /weight differs/);
    await assert.rejects(quoteRemoteOrder("OTHER-ID", parcel, "#1005"), /not found/);
  });
  await t.test("external assignment uses an existing shipment ID and persists a single claim across concurrent clicks", async () => {
    remote = endpoint => {
      if (endpoint === "shipments") return { data: [{ id: "EXTERNAL-SHIP", attributes: { status: "new", tracking_number: null, pickup_details: { zip: "400001" }, shipping_address: { zip: "110001" }, is_cod: false, cod_amount: 0 } }] };
      if (endpoint === "rates") return rates;
      if (endpoint === "forward-order-shipment") return { payload: { awb_code: "EXTERNAL-AWB", shipment_id: "EXTERNAL-SHIP" } };
      throw new Error(`Unmocked ${endpoint}`);
    };
    calls.length = 0;
    const results = await Promise.allSettled([assignRemoteOrder("EXTERNAL-SHIP", "carrier-1", parcel, "#1006"), assignRemoteOrder("EXTERNAL-SHIP", "carrier-1", parcel, "#1006")]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const assignment = calls.filter(call => call.endpoint === "forward-order-shipment");
    assert.equal(assignment.length, 1);
    assert.deepEqual(assignment[0].body, { shipment_id: "EXTERNAL-SHIP", carrier_id: "carrier-1" });
    assert.equal(remoteAssignments.get("EXTERNAL-SHIP")?.state, "booked");
    assert.equal(remoteAssignments.get("EXTERNAL-SHIP")?.awb, "EXTERNAL-AWB");
    await assert.rejects(assignRemoteOrder("EXTERNAL-SHIP", "carrier-1", parcel, "#1006"), /already has/);
    assert.ok(!calls.some(call => call.endpoint === "forward-order"));
  });
  await t.test("uncertain external assignments remain blocked and never recreate the Velocity order", async () => {
    remote = endpoint => {
      if (endpoint === "shipments") return { data: [{ id: "EXTERNAL-TIMEOUT", attributes: { status: "new", tracking_number: null, pickup_details: { zip: "400001" }, shipping_address: { zip: "110001" }, is_cod: false, cod_amount: 0 } }] };
      if (endpoint === "rates") return rates;
      throw new Error("Simulated timeout after courier assignment");
    };
    await assert.rejects(assignRemoteOrder("EXTERNAL-TIMEOUT", "carrier-1", parcel, "#1007"), /did not respond/);
    assert.equal(remoteAssignments.get("EXTERNAL-TIMEOUT")?.state, "attention");
    calls.length = 0;
    await assert.rejects(assignRemoteOrder("EXTERNAL-TIMEOUT", "carrier-1", parcel, "#1007"), /already has/);
    assert.equal(calls.length, 0);
  });
  await t.test("external assignments reject unavailable couriers and already assigned parcels", async () => {
    let awb: string | null = null;
    remote = endpoint => endpoint === "rates" ? rates : { data: [{ id: "EXTERNAL-INVALID", attributes: { status: "new", tracking_number: awb, pickup_details: { zip: "400001" }, shipping_address: { zip: "110001" }, is_cod: false, cod_amount: 0 } }] };
    await assert.rejects(assignRemoteOrder("EXTERNAL-INVALID", "not-serviceable", parcel, "#1008"), /available courier/);
    assert.equal(remoteAssignments.has("EXTERNAL-INVALID"), false);
    awb = "ALREADY-SHIPPED";
    await assert.rejects(assignRemoteOrder("EXTERNAL-INVALID", "carrier-1", parcel, "#1008"), /unassigned/);
  });
  await t.test("linked Velocity shipments cannot bypass Introvart fulfilment safeguards", async () => {
    const linked = [...shipments.values()].find(row => row.remoteShipmentId);
    assert.ok(linked?.remoteShipmentId);
    calls.length = 0;
    await assert.rejects(assignRemoteOrder(linked.remoteShipmentId, "carrier-1", parcel, "#1009"), /belongs to Introvart/);
    assert.equal(calls.length, 0);
  });
  await t.test("HTTP routes reject guests, prevent creator-wide reports and restrict customer tracking ownership", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    stub(prisma.staffSigningKey, "findUnique", async () => keys);
    const creator: Admin = { id: "creator-staff", email: "creator@example.test", name: "Creator", passwordHash: "", role: "creator", creatorId: "artist-1", disabled: false, tokenVersion: 0, createdAt: new Date(), updatedAt: new Date() };
    stub(prisma.admin, "findUnique", async () => creator);
    stub(prisma.artist, "findUnique", async () => ({ id: "artist-1", suspended: false }));
    const token = (await issueStaffToken(creator)).accessToken;
    const server = buildApp().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    try {
      assert.equal((await fetch(`${base}/admin/shipping-tools/config`)).status, 401);
      assert.equal((await fetch(`${base}/creator/shipping/reports`, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status, 403);
      assert.equal((await fetch(`${base}/creator/shipping/returns`, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
      for (const path of ["serviceability", "rates", "tracking", "cancel", "remote/forward", "remote/return"]) {
        const body = path === "serviceability" ? { from: "400001", to: "110001", payment_mode: "prepaid", shipment_type: "forward" }
          : path === "rates" ? { length: 30, width: 20, height: 5, weightGrams: 500, origin: "400001", destination: "110001", journey: "forward", paymentMode: "prepaid" }
            : path.startsWith("remote") ? {} : { awbs: ["TEST-RETURN"] };
        assert.equal((await fetch(`${base}/creator/shipping/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 403);
      }
      assert.equal((await fetch(`${base}/me/orders/order-1/tracking`, { headers: { "x-guest-id": "other-guest" } })).status, 404);
      assert.equal((await fetch(`${base}/me/orders/order-1/tracking`, { headers: { "x-guest-id": "guest-1" } })).status, 200);
      Object.assign(creator, { role: "operations", creatorId: null });
      const adminToken = (await issueStaffToken(creator)).accessToken;
      const post = (path: string, body: unknown) => fetch(`${base}/admin/shipping-tools/${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      remote = (endpoint) => {
        if (endpoint === "serviceability") return { result: { serviceability_results: [{ carrier_id: "carrier-1", carrier_name: "Test courier" }] } };
        if (endpoint === "rates") return rates;
        if (endpoint === "shipments" || endpoint === "returns") return { data: [{ id: "REMOTE-1", attributes: { status: "pending", tracking_number: "TEST-RETURN" } }], meta: { total_count: 1 } };
        if (endpoint === "order-tracking") return trackingMock("ready_for_pickup");
        if (endpoint === "cancel-order") return { message: "Cancellation in progress" };
        if (endpoint === "reports") return { payload: { summary: { pending: { count: 1 } } } };
        throw new Error(`Unmocked ${endpoint}`);
      };
      calls.length = 0;
      assert.equal((await post("serviceability", { from: "400001", to: "110001", payment_mode: "prepaid", shipment_type: "forward" })).status, 200);
      assert.equal((await post("rates", { length: 30, width: 20, height: 5, weightGrams: 500, origin: "400001", destination: "110001", journey: "return", paymentMode: "prepaid", qcApplicable: true })).status, 200);
      assert.equal(calls.at(-1)?.body.qc_applicable, true);
      const forward = await post("remote/forward", { page: 2, per_page: 50, warehouse_ids: ["WH1"], is_cod: false });
      assert.equal(forward.status, 200);
      assert.equal((await forward.json()).meta.total_count, 1);
      assert.deepEqual(calls.at(-1)?.body, { page: 2, per_page: 50, sort_order: "desc", warehouse_ids: ["WH1"], is_cod: false });
      assert.equal((await post("remote/return", { carrier_ids: ["CAR1"], qc_status: ["passed"], created_at__gte: "2026-10-01T00:00:00Z" })).status, 200);
      assert.equal(calls.at(-1)?.body.created_at__gte, "2026-10-01T00:00:00Z");
      assert.equal((await post("tracking", { awbs: ["TEST-RETURN"] })).status, 200);
      assert.equal((await post("cancel", { awbs: ["TEST-RETURN"] })).status, 200);
      assert.equal((await post("reports", { start_date_time: "2026-10-01T00:00:00Z", end_date_time: "2026-10-31T23:59:59Z", shipment_type: "return" })).status, 200);
      const localOrders = await fetch(`${base}/admin/shipping-tools/order-records?tab=all&perPage=10`, { headers: { Authorization: `Bearer ${adminToken}` } });
      assert.equal(localOrders.status, 200);
      const localBody = await localOrders.json();
      assert.equal(localBody.total, 1);
      assert.equal(localBody.counts.all, 1);
      assert.equal(localBody.items[0].customer.phone, "9999999999");
      const accountOrders = await post("order-records/velocity", { page: 1, per_page: 10, granular_status: ["new"] });
      assert.equal(accountOrders.status, 200);
      assert.equal((await accountOrders.json()).meta.total_count, 1);
      assert.equal((await post("order-records/velocity/REMOTE-1/ship", { length: 30, width: 20, height: 5, weightGrams: 500, carrierId: "carrier-1", packedDetailsConfirmed: false })).status, 400);
      const count = calls.length;
      assert.equal((await post("remote/forward", { unrecognized: true })).status, 400);
      assert.equal((await post("tracking", { awbs: Array.from({ length: 51 }, (_, index) => String(index)) })).status, 400);
      assert.equal((await post("cancel", { awbs: Array.from({ length: 51 }, (_, index) => String(index)) })).status, 400);
      assert.equal(calls.length, count);
      Object.assign(creator, { role: "support" });
      const supportToken = (await issueStaffToken(creator)).accessToken;
      const supportPost = (path: string) => fetch(`${base}/admin/shipping-tools/${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${supportToken}`, "Content-Type": "application/json" }, body: "{}",
      });
      assert.equal((await supportPost("remote/return")).status, 200);
      assert.equal((await supportPost("remote/forward")).status, 403);
      assert.equal((await supportPost("tracking")).status, 403);
      assert.equal((await supportPost("order-records/velocity")).status, 403);
      assert.equal((await supportPost("order-records/velocity/REMOTE-1/quote")).status, 403);
      assert.equal((await supportPost("order-records/velocity/REMOTE-1/ship")).status, 403);
      assert.equal((await fetch(`${base}/admin/shipping-tools/order-records`, { headers: { Authorization: `Bearer ${supportToken}` } })).status, 403);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
