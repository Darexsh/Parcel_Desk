# Straightship

Straightship is a Burnaby, BC cross-border parcel company that ships from China to North
America and delivers the last mile in Canada with its own fleet and local courier partners.
Its tracker shows scans at its own stations in British Columbia, Alberta, Manitoba and
Ontario. Tracked through its tracking page's own lookup.

## How it works

1. `direct`: one `GET https://www.straightship.com/track-your-shipment/tracking-id/{number}/`,
   the address the site's tracking form opens. It needs no cookie, token, key or browser. The
   server renders a summary table and the parcel's history, oldest first, into the page.
2. `retry`: the same request once more after a request that failed to reach the site or ran out
   of time. The first gets half of the budget.

- An unknown number is HTTP 200 with `No results found!` in place of the summary and the
  history, which is not found. A redirect or a 404 is a moved route.
- The page's title and the summary's Tracking ID repeat the number as it was asked, and must be
  the number asked. The tracker matches the whole number in any case; a shortened one is not
  found. The adapter asks in capitals.
- A firewall or bot check's page in place of the tracker, even with HTTP 200, is a challenge.
- Recognition makes the same request.

## Notes

- The page says under the history that every clock is UTC, and archived lookups agree: read in
  any Canadian zone, some rows would come after their capture and deliveries after the 9 pm
  the delivery round promises. With that note the clocks become instants. Without it, or with
  a row more than fifteen minutes after the lookup, they stay `local_time`.
- Station and delivery rows end with the town and province in brackets, such as `Delivered
  (Sampleton, BC)`. The bracket becomes the scan's location and the rest its wording, so one
  wording stages every station. The City column, which holds the town alone, is the location of
  a row without one. A place with a digit is not kept.
- `Package Received with Origin Scan warehouse` is the first scan in Canada and accepts the
  parcel; a station row with the same clock follows it. `Package will be delivered before
  9:00pm` is the delivery round. An attempt names the reason and asks the recipient to email
  Straightship. `Delivery is in progress` and `Your order is in Progress` come after a round
  that did not deliver and stay in transit. A parcel being returned can still go out again.
- The summary's Package Status stays `ReadyForShipping` while the parcel moves between
  stations, so the adapter stages the parcel from its rows. Universal providers relay that
  status, such as `Shipped` during the delivery round, as a scan; the status map knows it.
- The page asks for the recipient's name before it shows the delivery photos. The adapter
  sends no name and keeps neither the photos nor the summary's client code and package ID.

## Limitations

- No estimate, weight, service, sender or recipient.

## Numbers

Straightship numbers start with `STRTD` or `STRCA` followed by digits; `straightship-1` claims
the lengths archived lookups show. Its tracker also holds parcels under `STSH`, two letters and
eleven digits. One archived lookup shows that layout and Colis Privé's rule takes the same
characters, so `straightship-2` only offers Straightship and recognition asks its tracker. The
adapter takes both layouts. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking form opens `straightship.com/track-your-shipment/tracking-id/{number}/`; the
library reads the number from that path.

## Testing

`npm run test:carriers:live -- carriers/straightship`, with `STRAIGHTSHIP_TRACKING_NUMBER` and
optionally `STRAIGHTSHIP_UNKNOWN_NUMBER` set outside the repository.
