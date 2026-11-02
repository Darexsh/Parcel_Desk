# MailAmericas

MailAmericas is a cross-border carrier founded in Buenos Aires. It flies parcels bought from
overseas sellers, such as Shein and AliExpress orders, to Latin America, where its own delivery
arm or a local courier takes them to the door. It also delivers in Africa and the Middle East.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://mailamericas.com/api/tracking` with the body
   `{"trackingNumber":"{number}","language":"en"}`, as the tracking page sends it. It needs no
   cookie, token, key or browser. The JSON reply has the shipment's summary and its scans,
   newest first.

- An unknown number is HTTP 200 with `{"data":null}`, which the page reports as not found. A
  404 or a redirect is a moved route.
- The service sometimes fails with HTTP 500 and `{"error":"Error al consultar el tracking"}`
  for every number, known or not, so that reply is inconclusive.
- AWS's load balancer in front of the site refuses requests whose User-Agent is a bare client
  name such as curl, and refuses an address for a few minutes after a burst of lookups. Both
  get the same bare 403 page, which the adapter reports as rate limited. The package's default
  User-Agent passes.
- Some replies take twenty seconds or more. The single read gets the whole budget rather than
  half of it with a retry after.
- The shipment must echo the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `date` and `time` are a wall clock to the minute, with no zone. ParcelsApp shows
  them marked as UTC. The older tracker printed the same wall clocks with an offset that
  followed the leg, so the adapter dates two legs: the origin warehouse (`WH`) on the origin
  country's clock, and customs, the intermediate warehouse, the delivery offices and the
  delivery (`AD`, `WI`, `RC`, `LM`, `PF`) on Argentina's, Colombia's, Peru's, Mexico City's or
  Santiago's. The reply's origin country and the recipient's state, which it can abbreviate
  (`JAL.`), are read only for this.
- The older tracker gave Mexico City's clock to scans in Cancún and Ciudad Juárez too, so a
  Mexican scan is dated only when the recipient's state keeps Mexico City's clock at that time.
  A Chilean scan is dated only when the region keeps Santiago's; Valparaíso's includes Easter
  Island.
- Other scans keep `local_time`. Label creation, tax ID checks, notices, the flight, transit
  hubs, the arrival and a duty recorded as paid had other offsets or none, and no older history
  placed return scans. No older history placed scans in Ecuador, Uruguay, Costa Rica or Brazil
  either, and El Salvador's had an offset that is not El Salvador's. A warehouse in the
  destination country, an hour that summer time skips or repeats, and a reading after the
  lookup or out of order with a newer dated scan stay local too.
- `last_update` and `delivered_at` are the newest scan's instant when it has one; otherwise
  `last_update_local` has its wall clock.
- A scan's description is its leg, as the page heads it, then its own line, such as
  `Destination customs: Released`. The `code` (`AD-3`) stages it; the code's letters name the
  leg. Tax ID checks and the buyer's details form, notices, a duty recorded as paid and a delivery
  moved to a later round move nothing and have no stage.
- The page swaps some codes' wording for friendlier labels from `/api/tracking-labels`. The
  adapter keeps the scan's own wording and makes no second request.
- The summary's `status` decides a delivery, a return or a claim. A parcel retained at origin or
  held by customs is an exception.
- Delivery and delivery-office lines lose a clause naming who took the parcel, and every line
  loses phone numbers. The buyer's name and tax ID, the merchant, the recipient's town and the
  proof of delivery in the reply are not kept.
- The reply names the courier that delivers, which can be MailAmericas' own arm in the country,
  but not that courier's tracking number, so there is no hand-off.

## Limitations

- No weight. Node lookups date the scans that keep `local_time` on a deduced zone, the
  destination's for a scan without a place ([clocks](../../places/README.md#clocks)).
- The tracker also answers some senders' own references, which no rule claims.
- The tracker files some AliExpress parcels for Mexico under AliExpress's `LP` reference and
  answers their `MMXQP` number with that record. Nothing in the reply names the number asked,
  so it counts as another shipment and the lookup is inconclusive.

## Numbers

MailAmericas numbers start with `ML` and the destination country's code, then nine digits and
`R` or `EX`. Parcels for Mexico have `MMXQP`, nine digits and `E`, `N` or `R` instead. The
tracking page uses one of each as its examples, and no other carrier's numbers have these
shapes, so `mailamericas-ml` and `mailamericas-mmxqp` claim them. Parcels for the Dominican
Republic have `DOMC`, nine digits and `R`: the tracker answers them, a public question about a
parcel to the Dominican Republic quotes one beside MailAmericas, and no other carrier's numbers
have the shape, so `mailamericas-domc` claims it.

The tracker also answers parcels under UPU S10 numbers with the Mexican, Marshall Islands and
Mauritius codes. Mexican and Mauritius numbers stay with their own posts. The catalog has no
Marshall Islands post, and the MH numbers found on MailAmericas' and Cainiao's trackers are
MailAmericas parcels to Latin America, so a valid S10 number with that code is not international
mail: `mailamericas-s10` suggests MailAmericas first, and recognition asks it. The samples and
their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/mailamericas`, with `MAILAMERICAS_TRACKING_NUMBER` and
optionally `MAILAMERICAS_UNKNOWN_NUMBER` set outside the repository.
