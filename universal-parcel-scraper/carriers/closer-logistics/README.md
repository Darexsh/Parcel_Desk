# Closer Logistics

Closer Logistics is a Spanish last-mile delivery company whose deliveries include Zara online
orders. It also collects customers' returns at home. Tracked through the lookup its tracking
page makes.

## How it works

1. `direct`: one `GET https://admin.closerlogistics.com/tracking/shipments/{number}`, as the
   script of `tracking.closerlogistics.com/tracking/{number}` sends it. It needs no cookie,
   token, key, account or browser. The site carries a reCAPTCHA plugin, but the lookup sends
   no token. The JSON reply is the shipment: its type, its shop, its recipient, its latest
   incidence and each package's statuses, newest first.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An unknown number is HTTP 404 with `{"code":404,"message":"Not Found"}`, which the page
  reports as a parcel that does not exist or whose information has expired. The lookup gives
  the same answer for a path it has no route for.
- A redirect, which goes to the sign-in page, a 404 of another shape or a 410 is a moved
  service, a bot check's page is a challenge, and a reply that is not a shipment is a changed
  schema.
- The shipment must name the number asked.
- Recognition makes the same request.

## Notes

- A status has a code, such as `out_for_delivery`, and a clock written `DD/MM/YYYY HH:mm:ss`
  without a zone. The page shows the clocks as they come, so they stay `local_time`. Each
  event takes the label the page gives its code.
- A shipment is a delivery or a pickup, which collects a return from the customer for the
  shop. `for_return` is a failed delivery going back to the shop on a delivery and the next
  leg of the return on a pickup, so its stage follows the type and the status map leaves the
  code alone without one.
- The page dates its first step, the order received or the return to collect, with the
  shipment's creation until a status of its own dates it. The adapter adds that event the same
  way.
- The page shows only the first package's statuses on its progress rail. The adapter keeps
  every package's statuses and the same status at the same clock once.
- The shipment's own status, which the page gives as its latest, decides the current stage.
- The page shows the latest incidence's reason under a failed attempt. The adapter adds it to
  the failed attempt dated like the incidence.
- The shop is kept as the sender of a delivery. The recipient's name, phone number, address and
  coordinates, the driver's position, whoever took the parcel and internal identifiers are not.

## Limitations

- No place, delivery estimate, weight or delivery time as an instant.
- Older shipments drop out of the tracker, which then answers as for an unknown number.
- Only the latest incidence has a reason; earlier failed attempts have none.

## Numbers

Public complaints and a review about Zara orders give twelve-digit shipment numbers. Twelve
digits are shared with many carriers, so no rule claims them and recognition does not ask
Closer. The adapter takes twelve digits and refuses anything else without a request. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

`tracking.closerlogistics.com/tracking/` followed by the number opens one parcel; the tracking
box on closerlogistics.com builds that address.

## Testing

`npm run test:carriers:live -- carriers/closer-logistics`, with
`CLOSER_LOGISTICS_TRACKING_NUMBER` and optionally `CLOSER_LOGISTICS_UNKNOWN_NUMBER` set outside
the repository.
