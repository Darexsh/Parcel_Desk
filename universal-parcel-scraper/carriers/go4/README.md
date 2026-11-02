# GO4

GO4 is a Bratislava courier delivering within the city, across Slovakia and abroad; its
tracker also serves the bicycle courier Švihaj Šuhaj. Tracked through the lookup its tracking
page makes.

## How it works

1. `direct`: one `GET https://getstatus.go4.eu/status.php?from=go4status&parcelId={number}`,
   as the tracking page on `zona.go4.eu/status/` sends it. It needs no account, cookie, token,
   key or browser. Without `from=go4status` the lookup answers HTTP 401.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The JSON reply is a list holding one shipment's record. A record whose `Zasielka_Kod` is
  null is the page's "Zásielka sa nenašla", which is not found; the tracker gives it for every
  number it does not know. An empty reply or an empty list is inconclusive, a 401, a 403 or a
  firewall page is a challenge, and a 404 or a redirect is a moved route.
- The page shows the first record only. Its `Zasielka_Kod`, a JSON number or a string, must
  be the whole requested number, and no other record may name another one.

## Notes

- A record holds milestones rather than scans: the order, the courier's collection, the
  failed delivery attempts with their reasons, and the delivery. Each becomes a scan named
  with the page's own heading for it. The page heads the collection time "Na doručení od"
  (on delivery since); a delivery can follow the next day, so that scan is the parcel's
  acceptance.
- Clocks are wall clocks without an offset, read in Bratislava time; a clock with an offset
  keeps it. The zero date a database writes for a missing milestone counts as none.
- The current status is the page's line: the main status, then its detail. It settles a
  delivery or a return the milestones have not reached, and stages a record without them,
  which is then summary only.
- The reply's delivery estimate, which the page does not show, is the expected delivery while
  the parcel is on its way.
- The name of the person who took the parcel, the client's note and phone numbers in an
  attempt's reason are not kept.
- No detection rule claims GO4's numbers, so preflight never asks GO4. Recognition is declared
  because the lookup tells a known number from an unknown one; a number reaches the adapter
  when the caller names GO4 or pastes a tracking link.

## Limitations

- No live found reply has been seen: the tracker no longer knows the public sample numbers.
  The record is read as the tracker's bundled sample record and the page's template read it,
  so main statuses other than its "Delivered" fall to the shared wording rules.
- No scan locations, weight, service, proof of delivery or partner number.

## Numbers

GO4 is a Bratislava courier. Its tracker asks for a shipment number that starts with 1 and has
ten digits, or starts with 2 and has eleven. In the tracker's own sample record the first six
digits are the order date. Many carriers print bare digit runs of these lengths, so no rule
claims them.

## Links

The tracker reads the number from the `parcelId` parameter, so
`zona.go4.eu/status/?parcelId={number}` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/go4`, with `GO4_TRACKING_NUMBER` and optionally
`GO4_UNKNOWN_NUMBER` set outside the repository.
