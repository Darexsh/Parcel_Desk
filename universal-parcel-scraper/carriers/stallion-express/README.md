# Stallion Express

Stallion Express ships Canadian online sellers' parcels and hands them to partner carriers such
as Intelcom, USPS and PostNL for delivery. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://stallion.ca/wp-admin/admin-ajax.php` with the form fields
   `tracking_number` and `action=se_track_form_submission`. The tracking page's script sends the
   same request; it needs no cookie, nonce, key, account or browser. The reply is JSON served as
   HTML: the shipment's code, service, ship-to place, tracking number and partner link, then its
   scans.
2. `retry`: one more try when the request fails to reach the site or hangs, the first having
   had half of the budget, or when the site throttled it, once the wait it named is over.

- The tracker finds a shipment by Stallion's code or by the number its partner tracks it under.
  A reply counts only when its shipment code is the one asked for, and an SE number only when it
  is the label's own tracking number. A ten-character code that turns out to be another
  shipment's partner number is inconclusive. Partner numbers are invalid without a request; they
  stay with their carriers.
- "No shipment found" alone is the unknown-number answer. Any other error list, an empty reply
  or WordPress's `0` for a missing action is inconclusive.
- The site throttles the lookups of all its visitors together, so a lookup's first request can
  meet it however slowly this adapter asks. It answers "Too many requests" with HTTP 200, its
  limit and the seconds to wait in the JSON; no header carries them. The wait is a few seconds,
  and a lookup sent once it is over is answered. The adapter waits the named seconds and one
  more, for their rounding, then sends the lookup once again, when that leaves two seconds of
  the budget for the request. Otherwise, and when the lookup sent again is throttled too, the
  answer is `RateLimitedError` with the site's delay.
- Recognition makes the same request. `stallion-express-1` and `stallion-express-2` offer
  Stallion Express, so preflight asks this adapter.

## Notes

- The delivering partner is named only when Stallion's link to its tracker names the same
  carrier. Its number is the delivery tracking number when it differs from the one asked: the SE
  number for Intelcom, the partner's own number otherwise.
- Stallion's own scans ("Label created", "Received at …", "In-transit from …") carry true UTC
  stamps. The scans it relays from Intelcom are Intelcom's UTC clock read as Toronto time, so
  they are put back by Toronto's offset. Other partners' scans are kept as stamped.
- A receipt at a Stallion depot after the parcel has moved on is in transit, not its acceptance.
  A partner's label announcement after Stallion took the parcel is no step back. An undated
  announcement row is dropped.
- Only the country of the ship-to place is read, as the destination country. The town, the
  province and the partner's phone number are not.

## Numbers

Stallion's own shipment codes are ten characters: six digits that read as the shipping date,
year first, and four letters and digits. Its labels for Intelcom print the code behind `SE`.
`stallion-express-1` and `stallion-express-2` suggest Stallion Express at low confidence when
the six digits form a date and the four hold a letter; with four digits the code would be ten
digits, a shape many carriers share. The adapter takes both forms with any four letters or
digits.

## Links

Stallion's tracking page at `stallion.ca/track/` reads the number from its `tracking` parameter
and looks it up at once, so `stallion.ca/track/?tracking={number}` opens one shipment. Archived
lookups used the same parameter on the former `stallionexpress.ca`, and the shipping app opened
one at `ship.stallionexpress.ca/track/{number}`.

## Limitations

- No delivery estimate, weight, sender or recipient.
- Partner clocks other than Intelcom's are kept as Stallion stamps them.
- A shipment known by its partner number only is not tracked here; its partner's adapter reads it.

## Testing

`STALLION_EXPRESS_TRACKING_NUMBER=... STALLION_EXPRESS_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/stallion-express`
