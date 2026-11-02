# Roadrunner

Roadrunner is a US less-than-truckload freight carrier. Tracked by PRO through the lookup its
tracking portal makes.

## How it works

1. `direct`: one
   `GET https://tools.rrts.com/LTLTrack/TrackingShipment/ShipmentDataTab/{PRO}?appIDEncoded=`,
   the fragment the portal at `tools.rrts.com/LTLTrack/?searchValues={PRO}` loads for each
   number it looks up. The tracking form on `freight.rrts.com` sends its numbers to that portal.
   It needs no cookie, token, key or browser. The reply is an HTML fragment: the shipment's
   status, its parties, its overview and its travel history, oldest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The portal also finds a shipment by its pickup number, eight digits it reads as a number, so
  a PRO with a leading zero can open the shipment of that pickup. The overview's `Pro:` must be
  the PRO asked, with or without leading zeros; a shipment found any other way is
  inconclusive.
- "Invalid PRO number." is the portal's answer for a PRO it does not have, and the only missing
  shipment. An empty reply, a redirect, a 404 and a block page keep their own failure kinds.
- The adapter asks by whole PRO only; the portal's search by pickup number is not used, and its
  search by bill of lading or purchase order needs an account.
- Recognition makes the same request.

## Notes

- Each history row has a date, a time and the status. Clocks carry no zone and stay local times.
  An older version of the portal called them central standard time; the current one names no
  zone.
- A row about a trailer or a delivery run names a terminal: the one the trailer left, reached or
  was unloaded at, or the one the run left. That terminal becomes the scan's location, as the
  page writes it. Current rows give the terminal's name, which is not always its town; older
  shipments' rows give a town and state.
- The shipment status settles a delivery, a return or a problem, and a shipment without a staged
  row. Otherwise the newest staged row is ahead of it: the status can stay "Picked Up" while the
  rows move on. "Trailer Closed - ready for dispatch" also follows a delivery run. Calls to book a
  delivery appointment keep the shipment in transit; "Phone Number Not Available" moves nothing.
- The estimate is the overview's due date, dropped once the freight is delivered. The service is
  the one the services table names.
- The fragment names the shipper and consignee with their addresses, places them on a map, and
  holds the pickup number, the bill of lading, the ship date, the pieces, the weight without a
  unit, the payment terms, the special handling and the delivery receipt. None of them is read,
  nor are the forms to subscribe to updates.

## Limitations

- No sender, recipient, signature, weight or delivery receipt, and scans have no offset.
- A PRO reaches the adapter when it is filed under Roadrunner or opened from a Roadrunner link:
  nine digits are shared by many carriers, so no rule claims them and preflight does not ask it.
- Rows of older shipments can be gone: some show only their pickup.

## Numbers

Roadrunner tracks less-than-truckload freight by its PRO number, which its integration page
says is nine digits, an eight-digit PRO taking a leading zero; the adapter adds it. Its tracking
API guide shows one in a sample reply, and lookups archived from its tracking portal show more.
The samples and their sources are in [`numbers.json`](numbers.json). Eight-digit pickup numbers
find a shipment on the same portal; they are not recorded.

## Links

The tracking form opens `tools.rrts.com/LTLTrack/?searchValues={number}`. Roadrunner's
integration page links PROs to
`freight.rrts.com/Tools/Tracking/Pages/MultipleResults.aspx?PROS={number}`, an older results
page that still answers; older links use the same path on `www.rrts.com`. The library reads the
number from `searchValues` and from `PROS`.

## Testing

`npm run test:carriers:live -- carriers/roadrunner`, with `ROADRUNNER_TRACKING_NUMBER` and
optionally `ROADRUNNER_UNKNOWN_NUMBER` set outside the repository.
