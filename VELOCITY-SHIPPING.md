# Velocity Shipping integration

## Deployment and configuration

Deploy the backend before deploying the storefront:

```sh
npm ci
npm run db:deploy
npm run build
npm run test:shipping
```

Render's existing build command already runs migrations before building. Keep
`VELOCITY_API_KEY` in backend deployment secrets. Do not expose it through
`NEXT_PUBLIC_*`, commit it, or copy it into the storefront.

`VELOCITY_API_BASE_URL` defaults to `https://shazam.velocity.in`. The documented
staging host is `https://shazam.stagingvelocity.in`; confirm staging access and
credentials with Velocity before using it. Production booking actions create real
shipments and may schedule pickups and incur charges.

Warehouses are database configuration, not environment variables:

- Admin > Shipment > Pickup warehouses: use owner `platform` for the print partner
  or `creator:<artist ID>` for an artist.
- Creator > Shipping: a verified creator can configure only their own warehouse.
- Link an existing warehouse by entering its Velocity warehouse ID and exact
  registered pickup name, address, contact information and pincode.
- Leaving the ID blank explicitly creates a new warehouse through Velocity.
  If creation times out, find its ID in Velocity before retrying. Never blindly
  create another warehouse.
- Editing an existing warehouse changes local configuration only. Update Velocity
  separately and keep both configurations consistent.

The S3-compatible storage already used by Introvart stores private label PDFs.
Labels from Velocity's documented S3 host are retained immediately, because their
original signed URLs expire. Prepare label returns a five-minute signed URL after
staff/creator authorization. Other upstream label hosts must be downloaded in the
Velocity dashboard rather than fetched automatically by the server.

## Daily workflow

Admin navigation uses the same expandable child-page pattern as Content:

- Overview: existing production queue and dispatch metrics.
- Pickup warehouses: registration/linking, with optional GST on creation.
- Serviceability: eligible couriers between two pincodes.
- Rate calculator: standalone forward/COD/return quotes, including optional QC.
- Forward booking and Return pickups & QC: book platform order lines/approved cases.
- Courier assignment: assign an existing create-only order without recreating it.
- Tracking: read up to 50 account AWBs, including external Velocity shipments.
- Shipping labels: prepare/print authorized labels for either journey.
- Cancellations: local single-parcel and account-wide bulk cancellation, maximum 50
  AWBs, with a pre-pickup tracking check before submission.
- Velocity forward orders / Velocity return orders: account-wide search, pagination,
  detailed responses and the PDF's advanced filter parameters.
- Summary reports: UTC time-range summaries for forward and return journeys.

Results use courier comparison cards, shipment tables with readable details,
tracking timelines, charge breakdowns and status-summary reports rather than raw
JSON. The former setup child page is removed; existing links redirect to Overview.
Rate estimates may be strings or structured pickup/delivery objects. Both are
retained and displayed as readable fields; unavailable estimates are shown as
not provided rather than preventing courier comparison.

Account-wide read tools never import remote orders or change local refunds.
Forward date filters send Unix seconds; return date filters use the ISO UTC strings
shown in the PDF examples.
Return-only support roles see only permitted return child pages. All new endpoints
verify staff roles server-side; creators cannot access account-wide tools.

Customer shipping prices and checkout totals remain unchanged. Velocity quotes are
internal estimates, not an additional customer charge.

1. Configure a pickup warehouse for each physical origin.
2. Finish printing, QC and packing and mark platform jobs `ready`. Artists accept
   their seller-fulfilled/original order lines in Creator > Orders.
3. In Shipping, select a line/job and enter the actual packed length, width and
   height in centimetres and total packed weight in grams, including packaging.
   One shipment covers the entire quantity on that line/job as one parcel.
   Multi-parcel packing of a single line is not supported.
4. Compare rates, select a carrier or let Velocity's account shipping rules choose,
   and explicitly confirm booking. Choose the existing two-step workflow, one-step
   orchestration (order + courier + pickup), or create-only for deferred assignment.
   Create-only records reserve the parcel but do not generate an AWB yet.
5. Prepare/print the label, attach it and await courier pickup. Booking an AWB does
   not mark a job dispatched. Courier tracking updates the shipping/production
   status; staff can also confirm physical handover using the real AWB.
6. Customers see tracking under Account > Orders. Their tracking API never exposes
   internal charges, request addresses, warehouse IDs or label links.

Mixed platform/artist orders have separate shipment records for each physical
line/job. COD collectible amounts are proportionally allocated across lines in
integer cents so they sum exactly to the order payable. A replacement for an
already-delivered COD line is prepaid; a pre-delivery QC reprint still collects the
original amount. Do not create multiple live COD parcels for the same line.

Existing manual/external shipping remains possible, but dispatch requires a real
AWB. A Velocity AWB cannot be overwritten through a manual dispatch or AWB edit.
Commission requests remain on their existing commission workflow; they do not
have order-line shipping records.

## Tracking, errors and cancellation

- A 502 "unexpected response" from a Velocity quote includes schema issue paths in
  the error message and API details. Compare those paths with the rates response
  example in the Velocity PDF; the backend does not log or return the full payload.
- A five-minute backend task reconciles up to 25 active shipments, oldest/unsynced
  first. It reads tracking only and never books parcels. It needs an always-on
  backend process. Staff can also use Refresh / reconcile.
- Both forward and return tracking statuses are retained. Forward pickup/transit
  updates the line/job, and delivery uses the existing delivered/payment handling.
- A stable unique booking reference is persisted before any Velocity booking
  request. Two-step order creation and courier assignment retain remote IDs.
- On a timeout or partial booking failure, do not submit a new booking. Reconcile
  the existing record; only an exact external/remote ID match is accepted.
- Create-only orders can be assigned in Courier assignment (carrier ID or account
  rules). Assignment claims the existing record before calling Velocity; timeouts
  move it to `attention` rather than allowing a blind second assignment.
- If an uncertain remote order exists without an AWB, finish assignment in Velocity
  and then refresh Introvart. If the remote state cannot be uniquely identified,
  investigate with Velocity support using the displayed shipment reference.
- Cancellation is a request, not immediate success. `cancel_requested` remains
  until tracking confirms cancellation. Only then can that line/job be booked
  again. Cancelling a shipment does not refund or cancel the Introvart order.
- Cancel all live shipment records before cancelling an eligible Introvart order.
  Order-row locking and the cancellation claim prevent a competing booking from
  starting during cancellation/refund processing.
- If a backend process is interrupted during an Introvart order cancellation,
  `shippingBlocked` remains set. Investigate the gateway and order state before
  clearing the claim; never clear it merely to retry a payment/refund.

## Return pickups and reports

Admin > Returns offers explicit physical-pickup approval. In the Velocity return
workspace, quote and book the approved case. The customer becomes the pickup
address and the line's platform/artist warehouse becomes the destination.
Return parcels are prepaid and return QC is disabled by default. The admin can
explicitly request QC after confirming account/SKU setup and supplying a product
name, HTTPS product image and optional brand. The PDF limits QC to two SKUs and six
configured parameters, with Delhivery/Shadowfax coverage. Our one-line parcel uses
one SKU. Velocity can fall back to non-QC when service is unavailable: the UI does
not claim inspection is guaranteed or completed. Refund,
replacement and reprint decisions remain separate from courier pickup; a live
physical return must arrive or its cancellation must be confirmed before resolving
the case.

Operations/support roles can manage return pickups according to existing return
permissions. Creators cannot approve returns or access account-wide reports.
Resolution takes a persisted `resolving` claim under the same order-row lock used
by booking, preventing a refund/decision from racing a new pickup. Return refunds
reuse a stable Cashfree refund reference on retries. If a process stops while a
case is `resolving`, investigate payment and case state before restoring its prior
status; do not force a new pickup while resolution is incomplete.
Admin shipping and return workspaces expose Velocity's respective account-wide
status-summary reports over a UTC date range.

Webhooks are not enabled by this implementation. Polling provides tracking updates
without guessing webhook signatures or payloads. Add webhooks only after Velocity
confirms its signing headers, canonical payload format, replay handling and events.
Automated NDR reattempts, COD settlement reconciliation and insurance/
damage claims are not implemented as API operations; the supplied guide does not
fully specify these operational contracts.

## Endpoints

Verified staff shipping routes are mounted at:

- `/api/v1/admin/shipping-tools`
- `/api/v1/creator/shipping`
- `/api/v1/fulfil/shipping`

Each exposes:

| Method | Relative path | Purpose |
| --- | --- | --- |
| GET | `/config` | Key configured flag, environment and authorized warehouses |
| POST | `/serviceability` | Admin lane serviceability check |
| POST | `/rates` | Admin standalone lane quote, no order/warehouse required |
| POST | `/remote/:journey` | Admin account-wide filtered forward/return details |
| POST | `/tracking` | Admin read-only account AWB tracking, up to 50 |
| POST | `/cancel` | Admin bulk cancellation, up to 50; both journey permissions |
| POST | `/warehouses` | Link/create an authorized pickup warehouse |
| GET | `/queue` | Latest 100 eligible physical order lines/jobs |
| GET | `/returns` | Latest 100 open physical return cases; admin return roles only |
| POST | `/orders/:orderId/quote` | Internal live courier/rate comparison |
| POST | `/orders/:orderId/book` | Explicit forward or approved-return booking |
| GET | `/shipments?journey=forward&page=1&search=` | Paginated local shipment records |
| POST | `/shipments/:id/refresh` | Tracking and exact-reference reconciliation |
| POST | `/shipments/:id/assign` | Assign a courier to a create-only order |
| POST | `/shipments/:id/cancel` | Pre-pickup cancellation request |
| POST | `/shipments/:id/label` | Authorized short-lived label download URL |
| POST | `/reports` | Account-wide forward/return summary; admin roles only |

Booking/quote bodies include `itemId`, optional `jobId` or `returnCaseId`,
`length`, `width`, `height`, `weightGrams`, optional `carrierId`,
`bookingMode` (`two_step`, `orchestration`, `order_only`), and optional `returnQc`
(`productName`, `image`, optional `brand`, `configured: true`). Prices,
recipients, warehouse ownership and COD amounts are derived server-side.

The PDF's legacy `/auth-token` login is superseded by the generated API key; the
admin never collects Velocity passwords or exposes tokens. Webhook configuration
is a Velocity dashboard operation, not a documented API endpoint.

`GET /api/v1/me/orders/:id/tracking` exposes the safe tracking view only after
checking customer/guest order ownership.

## Validation

`npm run test:shipping` stubs all database and Velocity requests. It never creates
live warehouses, shipments, pickups or refunds. Backend and storefront production
builds validate the application wiring. A controlled production smoke test still
requires an actual configured warehouse and explicit booking approval.
