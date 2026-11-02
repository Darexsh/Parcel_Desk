# GoBolt

GoBolt, formerly Second Closet, is a Toronto delivery and fulfilment company serving Canada and
the United States. Merchants hand it their orders, and its drivers deliver them and collect
customers' returns. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one
   `GET https://api.secondcloset.com/logistics/api/v1/bolt_shipping_labels/search?tracking_number={number}`,
   as the tracker at `track.gobolt.com/tracking/{number}` makes it. It needs no cookie, token,
   key or browser. The JSON reply has the parcel's status, the steps of the page's progress rail
   and the parcel's steps, newest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An unknown number is HTTP 404 with `Tracking number not found`, which the page reports as not
  found. A number whose tracking GoBolt no longer serves is HTTP 404 with
  `Tracking number is expired`, which is inconclusive with the reason `history_expired`. Another
  404 or a redirect is a moved route.
- The lookup matches the whole number in any case and nothing shorter. The shipment's
  `tracking_number` must be the number asked.
- Cloudflare stands in front of the service. Its browser check in place of the reply is a
  challenge.
- Recognition makes the same request.

## Notes

- Each step's `created_at` is an instant with its offset, to the millisecond, and is kept with
  that offset, cut to the second. `label_delivered_at` dates the delivery.
  `estimated_delivery_date` is an instant the page shows as the expected time; its day becomes
  the estimate until the parcel is delivered.
- The step's `name`, such as `label_out_for_delivery`, stages it. A failed step,
  `label_failed`, carries its reason as its description, which the page shows as the driver's
  note: a visit the recipient missed or refused is a failed attempt, after which the parcel goes
  out again; a lost or damaged parcel or a problem on the route is an exception; a reason that
  sends the parcel back to the merchant is a return.
- A customer's return has pickup steps of its own, named `label_return_`. Its failed step is a
  pickup the driver missed, which leaves the parcel where it was, so it has no stage.
- A step's location is the facility's town, province and country. A location with a digit,
  which could be a street address or a postcode, is not kept.
- The page shows the delivery address, the delivery instructions, the time window, the van's
  position, the merchant and the delivery photos only after the recipient enters the order's
  postal code. The adapter does not ask for them.
- The reply names no carrier but GoBolt and no other number, so there is no hand-off.

## Limitations

- No weight, service or recipient.
- A number reaches the adapter when it is filed under GoBolt or opened from a GoBolt link: no
  rule claims GoBolt's numbers, so preflight does not ask it.
- GoBolt stops serving an old parcel's tracking, and the lookup then answers that the number is
  expired.

## Numbers

GoBolt tracks parcels by the number the merchant gives, seen as twelve digits and as twelve
letters and digits in archived and live replies of its tracking API, so the adapter takes
twelve letters and digits with at least one digit. Neither layout is published, and both are
shared with other carriers, so no rule claims them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`track.gobolt.com/tracking/{number}` opens one parcel, as the tracker's routes and archived
lookups show. The older `galileo.gobolt.com` host uses the same path. Both are read as links.

## Testing

`npm run test:carriers:live -- carriers/gobolt`, with `GOBOLT_TRACKING_NUMBER` and optionally
`GOBOLT_UNKNOWN_NUMBER` and `GOBOLT_EXPIRED_NUMBER` set outside the repository.
