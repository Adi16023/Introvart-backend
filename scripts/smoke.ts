// End-to-end smoke test against a running API. Usage: npm run dev (or start), then npm run smoke
const BASE = process.env.API_URL ?? "http://localhost:4000";
const STAFF = process.env.STAFF_API_KEY ?? "";

let failures = 0;
let passes = 0;

type Who = { customer?: string; guest?: string; creator?: string; admin?: string };

function headersFor(who: Who) {
  const headers: Record<string, string> = {};
  if (who.customer) headers["x-customer-id"] = who.customer;
  if (who.guest) headers["x-guest-id"] = who.guest;
  if (who.creator) headers["x-creator-id"] = who.creator;
  if (who.admin) headers["x-admin-role"] = who.admin;
  if (STAFF) headers["x-staff-key"] = STAFF;
  return headers;
}

async function call(method: string, path: string, who: Who = {}, body?: unknown) {
  const headers = { "content-type": "application/json", ...headersFor(who) };
  const res = await fetch(`${BASE}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* csv or empty */
  }
  return { status: res.status, data };
}

function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) {
    passes += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, extra === undefined ? "" : JSON.stringify(extra).slice(0, 300));
  }
}

const expectStatus = (name: string, res: { status: number; data: any }, status: number) => check(`${name} → ${status}`, res.status === status, { got: res.status, data: res.data });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function upload(kind: string, who: Who, bytes: Buffer, name = "photo.png", type = "image/png") {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
  const res = await fetch(`${BASE}/api/v1/uploads?kind=${kind}`, { method: "POST", headers: headersFor(who), body: form });
  return { status: res.status, data: (await res.json()) as any };
}

async function main() {
  console.log("Public catalogue");
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  check("health reports db up", health.db === "up", health);
  const cfg = await call("GET", "/config");
  check("config has sizes", cfg.data.sizes?.length >= 4, cfg.data);
  const home = await call("GET", "/home");
  check("home has banners and trending", home.data.banners?.length > 0 && home.data.trending?.length > 0, home.status);
  const list = await call("GET", "/artworks?limit=100");
  check("listing excludes drafts", list.data.items.every((a: any) => a.status === "approved"), list.status);
  const jasmine = await call("GET", "/search?q=jasmin&log=false");
  check("fuzzy search finds Jasmine Hour", jasmine.data.items?.some((a: any) => a.title === "Jasmine Hour"), jasmine.data.total);
  const detail = await call("GET", "/artworks/monsoon-window");
  check("artwork detail with options", detail.status === 200 && detail.data.options?.frames?.length > 0, detail.status);
  const quote = await call("POST", "/pricing/quote", {}, { artworkId: "a1", sizeId: "a3", materialId: "canvas", frameId: "oak" });
  check("price quote is server computed", quote.data.unitPrice > 0, quote.data);
  const pin = await call("GET", "/pincode/990001");
  check("pincode 99… is outside the map", pin.data.serviceable === false, pin.data);
  expectStatus("collection page", await call("GET", "/collections/quiet-light"), 200);
  expectStatus("policy page", await call("GET", "/policies/shipping"), 200);

  console.log("Customer, cart, checkout");
  const phone = `98${Math.floor(10000000 + Math.random() * 89999999)}`;
  const session = await call("POST", "/session", {}, { phone, name: "Smoke Tester", email: `smoke${phone}@example.com` });
  const me = session.data.id as string;
  check("session creates a customer", Boolean(me), session.data);
  const who: Who = { customer: me };
  expectStatus("cart needs identity", await call("GET", "/cart"), 400);
  const add = await call("POST", "/cart/items", who, { artworkId: "a1", sizeId: "a3", materialId: "matte", frameId: "oak", quantity: 2 });
  check("add to cart", add.status === 201, add.data);
  const cart = await call("GET", "/cart", who);
  const unit = quote.data.unitPrice as number;
  const q2 = await call("POST", "/pricing/quote", {}, { artworkId: "a1", sizeId: "a3", materialId: "matte", frameId: "oak" });
  const unitOak = q2.data.unitPrice as number;
  check("cart price comes from the server", cart.data.items?.[0]?.unitPrice === unitOak && cart.data.subtotal === unitOak * 2, { unitOak, cart: cart.data.subtotal });
  console.log("Uploads and the bucket");
  expectStatus("uploads need an identity", await upload("custom-print", {}, PNG), 400);
  expectStatus("unknown upload kind", await upload("avatar", who, PNG), 400);
  expectStatus("a text file renamed .png is refused", await upload("custom-print", who, Buffer.from("not an image at all"), "evil.png"), 415);
  expectStatus("a shopper cannot upload artwork masters", await upload("artwork", who, PNG), 401);
  const svg = await upload("custom-print", who, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "x.svg", "image/svg+xml");
  expectStatus("SVG is refused", svg, 415);
  const up = await upload("custom-print", who, PNG);
  check("upload is stored in the bucket", up.status === 201 && up.data.url.includes("/api/v1/media/custom-prints/") && up.data.visibility === "private", up.data);
  const served = await fetch(up.data.url);
  const servedBytes = Buffer.from(await served.arrayBuffer());
  check("file is served back from the bucket", served.status === 200 && served.headers.get("content-type") === "image/png" && servedBytes.equals(PNG), { status: served.status });
  check("served with safe headers", served.headers.get("x-content-type-options") === "nosniff" && served.headers.get("cross-origin-resource-policy") === "cross-origin");
  expectStatus("unknown media key is 404", { status: (await fetch(`${BASE}/api/v1/media/custom-prints/2026-10/00000000-0000-0000-0000-000000000000.png`)).status, data: null }, 404);
  expectStatus("path traversal is refused", { status: (await fetch(`${BASE}/api/v1/media/..%2f..%2fsecret`)).status, data: null }, 404);
  expectStatus("external image link refused", await call("POST", "/cart/items", who, { title: "Free print", image: "https://example.com/x.jpg", sizeId: "a4" }), 400);
  expectStatus("inline data URL refused", await call("POST", "/cart/items", who, { title: "Free print", image: "data:image/png;base64,iVBORw0KGgo=", sizeId: "a4" }), 400);
  expectStatus("forged media URL refused", await call("POST", "/cart/items", who, { title: "Free print", image: `${BASE}/api/v1/media/custom-prints/2026-10/11111111-1111-1111-1111-111111111111.png`, sizeId: "a4" }), 400);
  expectStatus("someone else's upload refused", await call("POST", "/cart/items", { customer: "c2" }, { title: "Stolen", image: up.data.url, sizeId: "a4" }), 400);
  const forged = await call("POST", "/cart/items", who, { title: "Free print", image: up.data.url, fulfilment: "original", unitPrice: 1, sizeId: "a4" });
  check("client cannot choose fulfilment for custom items", forged.data.fulfilment === "custom_print" && forged.data.image === up.data.url, forged.data);
  await call("DELETE", `/cart/items/${forged.data.id}`, who);
  const design = await call("POST", "/me/designs", who, { title: "Terrace", image: up.data.url, kind: "Custom print", detail: "A3" });
  check("saved design uses the uploaded file", design.status === 201 && design.data.image === up.data.url, design.data);
  const reviewPhoto = await upload("review", who, PNG);
  const photoReview = await call("POST", "/reviews", who, { artworkId: "a5", rating: 4, text: "Colours are true", photo: reviewPhoto.data.url });
  check("review photo goes through the bucket", photoReview.status === 201 && photoReview.data.photo === reviewPhoto.data.url, photoReview.data);
  expectStatus("review photo cannot be an outside link", await call("POST", "/reviews", who, { artworkId: "a6", rating: 4, text: "Nice", photo: "https://example.com/p.jpg" }), 400);
  const retPhoto = await upload("return", who, PNG);
  const refPhoto = await upload("commission", who, PNG);
  check("return and commission uploads accepted", retPhoto.status === 201 && refPhoto.status === 201, { retPhoto: retPhoto.data, refPhoto: refPhoto.data });
  expectStatus("a return photo cannot be used as a commission reference", await call("POST", "/commissions", who, { artistSlug: "kabir-sen", medium: "Acrylic", size: "A3", notes: "Check", budget: 20000, references: [retPhoto.data.url] }), 400);
  const totals = await call("POST", "/checkout/totals", who, { coupon: "WELCOME10", delivery: "standard", pincode: "560038", useCredit: false });
  const sub = unitOak * 2;
  const disc = Math.round(sub * 0.1);
  const payableExpected = sub - disc;
  check("coupon 10% and free shipping over ₹2,999", totals.data.discount === disc && totals.data.shipping === 0 && totals.data.payable === payableExpected, totals.data);
  const badCoupon = await call("POST", "/checkout/totals", who, { coupon: "NOPE", pincode: "560038" });
  check("unknown coupon is flagged", badCoupon.data.couponOk === false, badCoupon.data);
  const addr = { name: "Smoke Tester", phone, line: "12 Test Lane, Indiranagar", city: "Bengaluru", state: "Karnataka", pincode: "560038", label: "Home" };
  expectStatus("remote pincode 99 blocked", await call("POST", "/orders", who, { address: { ...addr, pincode: "990001" }, paymentMethod: "upi", delivery: "standard" }), 400);
  expectStatus("COD blocked above limit", await call("POST", "/orders", who, { address: addr, paymentMethod: "cod", delivery: "standard", coupon: "WELCOME10" }), 400);
  const order = await call("POST", "/orders", who, { address: addr, paymentMethod: "upi", delivery: "standard", coupon: "WELCOME10" });
  check("order placed pending payment", order.status === 201 && order.data.paymentStatus === "pending" && order.data.payable === payableExpected, order.data);
  const orderId = order.data.id as string;
  check("no print job before payment", order.data.jobs.length === 0);
  const paid = await call("POST", `/orders/${orderId}/payment`, who, { result: "paid" });
  check("payment confirms order and creates a print job", paid.data.paymentStatus === "paid" && paid.data.jobs.length === 1 && paid.data.items[0].status === "confirmed", paid.data);
  const again = await call("POST", `/orders/${orderId}/payment`, who, { result: "paid" });
  check("payment confirmation is idempotent", again.status === 200 && again.data.jobs.length === 1);
  const emptyCart = await call("GET", "/cart", who);
  check("cart emptied after payment", emptyCart.data.count === 0);
  const address = await call("GET", "/me/addresses", who);
  check("address saved from checkout", address.data.length === 1);
  const inv = await call("GET", `/me/orders/${orderId}/invoice`, who);
  check("invoice has GST breakdown", inv.data.gstIncluded > 0 && inv.data.total === payableExpected, inv.data);
  expectStatus("other customer cannot read order", await call("GET", `/me/orders/${orderId}`, { customer: "c2" }), 404);

  console.log("Fulfilment partner");
  const job = paid.data.jobs[0].id as string;
  for (const status of ["accepted", "printing", "framing", "qc", "packing", "ready"]) {
    const r = await call("POST", `/fulfil/jobs/${job}/status`, {}, { status });
    if (r.status !== 200) check(`job → ${status}`, false, r.data);
  }
  const mid = await call("GET", `/me/orders/${orderId}`, who);
  check("order line follows the job (packed)", mid.data.items[0].status === "packed", mid.data.items[0]);
  const dispatched = await call("POST", `/fulfil/jobs/${job}/status`, {}, { status: "dispatched" });
  check("dispatch assigns an AWB", Boolean(dispatched.data.awb), dispatched.data);
  const delivered = await call("POST", `/admin/orders/${orderId}/items/${paid.data.items[0].id}/delivered`, { admin: "marketing" });
  expectStatus("marketing cannot use the shipping desk", delivered, 403);
  const deliveredOk = await call("POST", `/admin/orders/${orderId}/items/${paid.data.items[0].id}/delivered`, { admin: "super" });
  check("delivery recorded", deliveredOk.data.items?.[0]?.status === "delivered", deliveredOk.data);

  console.log("Returns");
  const ret = await call("POST", "/me/returns", who, { orderId, itemId: paid.data.items[0].id, reason: "Corner scuffed", type: "refund", photos: [retPhoto.data.url] });
  check("customer opens a return with a photo", ret.status === 201 && ret.data.photos?.[0] === retPhoto.data.url, ret.data);
  expectStatus("duplicate return blocked", await call("POST", "/me/returns", who, { orderId, itemId: paid.data.items[0].id, reason: "again", type: "refund" }), 409);
  expectStatus("marketing cannot decide returns", await call("POST", `/admin/returns/${ret.data.id}/decide`, { admin: "marketing" }, { decision: "refunded" }), 403);
  const decided = await call("POST", `/admin/returns/${ret.data.id}/decide`, { admin: "support" }, { decision: "refunded" });
  check("support refunds the return", decided.data.status === "refunded", decided.data);

  console.log("Gift cards, cancellation, stock");
  const gift = await call("POST", "/gift-cards", { guest: "g1" }, { amount: 2500, from: "Smoke", to: "Friend", email: "f@example.com", theme: "Birthday" });
  check("gift card issued", gift.status === 201 && gift.data.balance === 2500, gift.data);
  const bal = await call("GET", `/gift-cards/balance?code=${gift.data.code}`);
  check("balance lookup", bal.data.balance === 2500, bal.data);
  const q3 = await call("POST", "/pricing/quote", {}, { artworkId: "a2", sizeId: "a4", materialId: "matte", frameId: "none" });
  await call("POST", "/cart/items", who, { artworkId: "a2", sizeId: "a4", materialId: "matte", frameId: "none" });
  const giftOrder = await call("POST", "/orders", who, { address: addr, paymentMethod: "upi", delivery: "standard", giftCardCode: gift.data.code });
  check("gift card covers a small order fully and settles at once", giftOrder.status === 201 && giftOrder.data.payable === 0 && giftOrder.data.paymentStatus === "paid" && giftOrder.data.jobs.length === 1, giftOrder.data);
  const bal2 = await call("GET", `/gift-cards/balance?code=${gift.data.code}`);
  check("gift card balance reduced", bal2.data.balance === 2500 - q3.data.unitPrice - 149, bal2.data);
  const cancel = await call("POST", `/me/orders/${giftOrder.data.id}/cancel`, who);
  check("order cancelled", cancel.data.paymentStatus === "refunded" || cancel.data.paymentStatus === "cancelled", cancel.data);
  const bal3 = await call("GET", `/gift-cards/balance?code=${gift.data.code}`);
  check("gift card balance restored", bal3.data.balance === 2500, bal3.data);

  const original = list.data.items.find((a: any) => a.fulfilment === "original" && a.stock === 1);
  if (original) {
    const guest: Who = { guest: "smoke-guest" };
    await call("POST", "/cart/items", guest, { artworkId: original.id });
    const guestOrder = await call("POST", "/orders", guest, { address: addr, paymentMethod: "upi", delivery: "standard", email: "guest@example.com" });
    check("guest checkout reserves the only original", guestOrder.status === 201, guestOrder.data);
    const gone = await call("GET", `/artworks/${original.slug}`);
    check("sold-out original shows stock 0", gone.data.stock === 0, gone.data.stock);
    const second = await call("POST", "/cart/items", who, { artworkId: original.id });
    check("cannot add a sold-out original", second.status === 409, second.data);
    const failed = await call("POST", `/orders/${guestOrder.data.id}/payment`, guest, { result: "failed" });
    check("failed payment releases stock", failed.data.paymentStatus === "failed");
    const back = await call("GET", `/artworks/${original.slug}`);
    check("stock back to 1", back.data.stock === 1, back.data.stock);
    await call("POST", `/me/orders/${guestOrder.data.id}/cancel`, guest);
  }

  console.log("Commissions");
  const com = await call("POST", "/commissions", who, { artistSlug: "kabir-sen", medium: "Acrylic", size: "18 × 24 in", notes: "A market at dusk", budget: 20000, deadline: "2026-12-20", references: [refPhoto.data.url] });
  check("commission requested with a reference photo", com.status === 201 && com.data.references?.[0] === refPhoto.data.url, com.data);
  const comId = com.data.id as string;
  const creatorKabir: Who = { creator: "kabir" };
  expectStatus("other creator cannot quote", await call("POST", `/creator/commissions/${comId}/quote`, { creator: "meera" }, { price: 20000, timeline: "6 weeks" }), 403);
  const quoted = await call("POST", `/creator/commissions/${comId}/quote`, creatorKabir, { price: 20000, timeline: "6 weeks", revisions: 1 });
  check("creator sends a quote", quoted.data.status === "quoted", quoted.data);
  const accepted = await call("POST", `/commissions/${comId}/accept`, who);
  check("customer accepts, half held", accepted.data.status === "accepted" && accepted.data.paid === 10000, accepted.data);
  await call("POST", `/creator/commissions/${comId}/progress`, creatorKabir, { text: "Underdrawing done" });
  const rev = await call("POST", `/commissions/${comId}/revision`, who, { message: "Warmer sky" });
  check("revision within the quote allowance", rev.data.status === "revision", rev.data);
  await call("POST", `/creator/commissions/${comId}/progress`, creatorKabir, { text: "Sky warmed" });
  expectStatus("second revision blocked", await call("POST", `/commissions/${comId}/revision`, who, { message: "again" }), 409);
  const approved = await call("POST", `/commissions/${comId}/approve`, who);
  check("approving releases the full price", approved.data.status === "approved_final" && approved.data.paid === 20000, approved.data);

  console.log("Creator studio");
  const reg = await call("POST", "/creator/register", {}, { name: `Smoke Studio ${phone}`, email: `studio${phone}@example.com`, phone, city: "Pune" });
  check("creator registers", reg.status === 201, reg.data);
  const cid = reg.data.id as string;
  const studio: Who = { creator: cid };
  const master = await upload("artwork", studio, PNG, "master.png");
  check("creator master file stored in the bucket", master.status === 201 && master.data.url.includes("/api/v1/media/artworks/") && master.data.visibility === "public", master.data);
  const anonMaster = await fetch(master.data.url);
  check("public artwork media readable without identity", anonMaster.status === 200);
  expectStatus("artwork with an outside image link refused", await call("POST", "/creator/artworks", studio, { title: "Linked", story: "x", basePrice: 2500, image: "https://example.com/a.jpg" }), 400);
  expectStatus("another creator cannot use this master", await call("POST", "/creator/artworks", { creator: "meera" }, { title: "Stolen", story: "x", basePrice: 2500, image: master.data.url }), 400);
  const noRights = await call("POST", "/creator/artworks", studio, { title: "Smoke Print", story: "Test", basePrice: 2500, image: master.data.url });
  check("artwork keeps the bucket URL", noRights.data.image === master.data.url && noRights.data.roomImage === master.data.url, noRights.data);
  check("without rights the work stays a draft", noRights.data.status === "draft", noRights.data);
  expectStatus("submitting without rights blocked", await call("POST", `/creator/artworks/${noRights.data.id}/submit`, studio), 400);
  await call("POST", `/creator/artworks/${noRights.data.id}/rights`, studio);
  const submitted = await call("POST", `/creator/artworks/${noRights.data.id}/submit`, studio);
  check("submit after rights → submitted", submitted.data.status === "submitted", submitted.data);
  const modsees = await call("GET", "/admin/moderation", { admin: "moderator" });
  check("moderator sees the queue", modsees.data.some((a: any) => a.id === noRights.data.id));
  expectStatus("rejection needs a note", await call("POST", `/admin/artworks/${noRights.data.id}/decision`, { admin: "moderator" }, { decision: "reject" }), 400);
  const live = await call("POST", `/admin/artworks/${noRights.data.id}/decision`, { admin: "moderator" }, { decision: "approve" });
  check("approved work goes live", live.data.status === "approved");
  const found = await call("GET", `/artworks/${live.data.slug}`);
  check("approved work is public", found.status === 200);
  const rev1 = await call("POST", "/reviews", who, { artworkId: "a4", rating: 5, text: "Looks great on the wall" });
  check("review lands pending", rev1.data.status === "pending", rev1.data);
  const before = (await call("GET", "/artworks/estuary")).data;
  await call("POST", `/admin/reviews/${rev1.data.id}/moderate`, { admin: "moderator" }, { status: "approved" });
  const after = (await call("GET", "/artworks/estuary")).data;
  check("approving a review updates the aggregate", after.reviewCount === before.reviewCount + 1, { before: before.reviewCount, after: after.reviewCount });
  const kyc = await call("PUT", "/creator/kyc", studio, { pan: "ABCDE1234F", bank: "HDFC ••1111", ifsc: "HDFC0001234" });
  check("KYC submitted", kyc.data.kyc === "pending", kyc.data);
  expectStatus("payout blocked until KYC verified", await call("POST", "/creator/payouts/request", studio, {}), 403);
  const boost = await call("POST", "/creator/promotions", studio, { days: 7 });
  const decidedBoost = await call("POST", `/admin/promotions/${boost.data.id}/decision`, { admin: "marketing" }, { decision: "approved" });
  check("marketing approves a boost", decidedBoost.data.status === "approved", decidedBoost.data);
  const coupon = await call("POST", "/creator/coupons", studio, { code: `SMOKE${phone.slice(-4)}`, value: 10, min: 500 });
  check("creator publishes a coupon", coupon.status === 201, coupon.data);

  console.log("Seeded creator ledger and payouts");
  const earn = await call("GET", "/creator/earnings", { creator: "arjun" });
  check("arjun has available earnings", earn.data.totals?.available > 0, earn.data.totals);
  const reqPayout = await call("POST", "/creator/payouts/request", { creator: "arjun" }, {});
  check("verified creator requests payout", reqPayout.status === 201, reqPayout.data);
  expectStatus("support cannot release payouts", await call("POST", `/admin/payouts/${reqPayout.data.id}/release`, { admin: "support" }), 403);
  const released = await call("POST", `/admin/payouts/${reqPayout.data.id}/release`, { admin: "finance" });
  check("finance releases payout", released.data.status === "released", released.data);
  const payouts = await call("GET", "/creator/payouts", { creator: "arjun" });
  check("nothing left to withdraw", payouts.data.totals.withdrawable === 0, payouts.data.totals);

  console.log("Admin desks");
  const bannerImg = await upload("cms", { admin: "marketing" }, PNG, "hero.png");
  check("marketing uploads a banner image", bannerImg.status === 201, bannerImg.data);
  expectStatus("support cannot upload CMS images", await upload("cms", { admin: "support" }, PNG), 403);
  const banner = await call("POST", "/admin/cms/banners", { admin: "marketing" }, { title: "Smoke hero", image: bannerImg.data.url });
  check("banner stores the bucket URL", banner.status === 201 && banner.data.image === bannerImg.data.url, banner.data);
  expectStatus("banner with an outside image refused", await call("POST", "/admin/cms/banners", { admin: "marketing" }, { title: "Bad", image: "https://example.com/x.png" }), 400);
  await call("DELETE", `/admin/cms/banners/${banner.data.id}`, { admin: "marketing" });
  expectStatus("no role → 401", await call("GET", "/admin/customers"), 401);
  expectStatus("moderator cannot open finance", await call("GET", "/admin/finance", { admin: "moderator" }), 403);
  const creators = await call("GET", "/admin/creators", { admin: "moderator" });
  check("bank details hidden from moderator", creators.data[0].bank === "Hidden for this role", creators.data[0]);
  const fin = await call("GET", "/admin/finance", { admin: "finance" });
  check("finance totals", fin.data.gmv > 0 && fin.data.giftCardLiability >= 0, fin.data);
  const csv = await call("GET", "/admin/finance/orders.csv", { admin: "finance" });
  check("finance CSV export", typeof csv.data === "string" && csv.data.startsWith("order_id"));
  const dash = await call("GET", "/admin/dashboard", { admin: "super" });
  check("dashboard", dash.data.orders >= 3, dash.data);
  const pricing = await call("PUT", "/admin/pricing", { admin: "super" }, { freeShippingOver: 2999 });
  check("super updates pricing", pricing.status === 200, pricing.data);
  const audit = await call("GET", "/admin/audit?limit=5", { admin: "super" });
  check("admin actions are audited", audit.data.length > 0 && audit.data.some((a: any) => /Refunded|marked|Released|Updated|Delivered|delivered/.test(a.action)), audit.data);
  const analytics = await call("GET", "/admin/analytics", { admin: "marketing" });
  check("analytics", analytics.status === 200, analytics.data);
  const roles = await call("GET", "/admin/roles", { admin: "super" });
  check("role matrix", roles.data.length === 6);
  const tickets = await call("POST", "/support/tickets", who, { subject: "Where is my order", body: "Please update" });
  const replied = await call("POST", `/admin/tickets/${tickets.data.id}/reply`, { admin: "support" }, { message: "On its way" });
  check("ticket reply moves it to pending", replied.data.status === "pending", replied.data);
  const lead = await call("POST", "/b2b/leads", {}, { company: "Hotel X", contact: "A", city: "Jaipur", brief: "Corridor art", quantity: 10, budget: 100000 });
  const quotedLead = await call("PATCH", `/admin/b2b/${lead.data.id}`, { admin: "super" }, { quote: { amount: 90000 } });
  check("B2B lead quoted", quotedLead.data.status === "quoted", quotedLead.data);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
