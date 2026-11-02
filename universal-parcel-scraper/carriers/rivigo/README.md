# Rivigo

Rivigo is a B2B express network in India. Mahindra Logistics bought the business and its brand,
and runs it as Rivigo by Mahindra Logistics on the same tracker. Tracked through the lookup its
public tracking page makes.

## How it works

1. `direct`: one `GET https://zoom-api.rivigo.com/tracking/v2/cnote/{number}`, as the Zoom
   tracking page at `zoom.rivigo.com/#/trackconsignment/{number}` makes it for a visitor who is
   not signed in. It needs no cookie, token, key or browser. The JSON reply holds the
   consignment's summary and its scans, oldest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A number Rivigo holds nothing under is HTTP 200 with `Please check the cnote number entered.`,
  which the adapter reads as `NotFoundError`. Another notice is a schema change; a 404 or a
  redirect is a moved route.
- A consignment Rivigo holds but does not show answers `Tracking of this consignment is not
  available`. That is inconclusive (`tracking_withheld`), never not found.
- The page sends its build in an `appVersion` header, and an outdated build gets an empty HTTP
  205. The adapter sends none, which gets the reply; a 205 is a schema change.
- The consignment must carry the number asked.
- Recognition makes the same request.

## Notes

- Mahindra Logistics' tracker, `tracking.mahindralogistics.com`, searches every reference
  type, opens the result on `zoom-ops.rivigo.com`, the same Zoom page on another host, and
  that page makes the same lookup. The adapter skips the search: it matches any reference,
  invoice numbers included, so it can answer with other businesses' consignments.
- Scan times are epoch milliseconds, kept as instants in UTC. When the newest row is a
  vehicle's leg (`INTRANSIT`), its time is the leg's arrival estimate, which the page labels
  ETA, and the row is left out.
- A scan's `status` code stages it, and its `activity` is the wording, such as `Origin PC -
  IN`. A booking or first leg worded `Pickup` is the collection. The location is the scan's
  city, as the public page shows it.
- A delivery is partial while boxes are split off under child consignments, and a consignment
  with a return consignment raised for it is on its way back. Neither counts as delivered.
- The estimate is `edd`, read as a day in India.
- The reply carries the consignor and consignee, and the scans the staff who made them. None of
  them is read, nor are the invoice, the proof of delivery, the child and return consignment
  numbers or the failed attempts' reasons and contacts.

## Limitations

- The parser follows the fields the tracking page's script reads, since every public sample is
  withheld. A history laid out otherwise reads as a malformed reply, so the enabled fallbacks
  answer.
- When the page links an earlier part of the history elsewhere (`lfTrackingUrl`), only the
  newer part is read and the history is marked truncated.
- A consignment reaches the adapter when it is filed under Rivigo or opened from a Zoom link:
  ten digits are shared by many carriers, so no rule claims them and preflight does not ask
  it.

## Numbers

Rivigo consignment numbers are ten digits, as customers quote them in complaints. No rule
claims them, since many carriers print ten-digit runs. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The Zoom tracker opens one consignment at `zoom.rivigo.com/#/trackconsignment/` followed by the
number, and Mahindra Logistics' tracker opens it at the same address on `zoom-ops.rivigo.com`.
The route works without a login, while the rest of Zoom is the staff panel. The library reads
the number from either host's link.

## Testing

`npm run test:carriers:live -- carriers/rivigo`, with `RIVIGO_TRACKING_NUMBER` and optionally
`RIVIGO_WITHHELD_NUMBER` and `RIVIGO_UNKNOWN_NUMBER` set outside the repository.
