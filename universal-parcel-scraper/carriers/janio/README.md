# Janio

Janio is a Singapore cross-border e-commerce logistics company that ships parcels into and
within Southeast Asia, handing them to a local partner for the delivery. Tracked through the
lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://tracker.janio.asia/api/v2/tracker/related-updates/?tracking_nos={number}`,
   as the tracking page sends it. It needs no cookie, token, key or browser. The JSON reply is
   a list with an entry for the parcel and any orders related to it, each with its status
   updates newest first.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- An unknown number is HTTP 200 with an empty list, which the page shows as "No data". A 404
  or a redirect is a moved route. An entry without updates, which the page also shows as "No
  data", has no history.
- The entry must carry the number asked as its `tracking_no`, or as its `searched_by` for a
  parcel found by a partner's reference. The page binds them the same way; the other entries
  are not read.
- The service answers `Accept: text/html` with HTTP 406, so the adapter asks for JSON.
- Recognition makes the same request.

## Notes

- `updated_on` is an ISO instant in UTC, so the updates are instants.
- A status code names the leg: the order, the pickup, the origin country, the flight, the
  destination country and the delivery. `DELIVERY_IN_PROGRESS` comes when the partner's
  courier has the parcel, hours before the delivery, so it is out for delivery.
- An update's location is its `country`. Its `address` is left out: on pickup and delivery
  updates it holds part of the recipient's address. The recipient's masked email, the origin
  country and the partners' own status codes are not kept either.
- `external_tracking_nos` maps Janio's key for each partner to that partner's reference. The
  references can repeat Janio's own number or belong to Janio's first-mile legs, so a
  partner is named only when exactly one entry gives a catalog carrier whose rules offer the
  reference. Janio's `singpost` and `scg` keys are SingPost and SCG Express, and `spx` is SPX
  Singapore, whose tracker the page links `spx` references to. Other keys are read as
  carrier names.
- A parcel found by a partner's reference returns Janio's own number as the canonical one.

## Limitations

- The page shows a delivery estimate for some parcels to Singapore and Malaysia. The adapter
  does not read it, since no reply seen had one.
- No weight, service, sender or recipient.
- The tracker forgets some older parcels: they come back as an unknown number.
- The page shows an SPX parcel's updates in SPX's words from `partner_data`. The adapter keeps
  Janio's own wording.

## Numbers

Janio's tracker shows JN, two letters such as CN or TH and twelve digits, for example on
AliExpress parcels delivered in Singapore, which Cainiao also tracks. The low-confidence rule
suggests Janio for that layout and sits next to AliExpress's rule for the JNCN form. Older
lookups show order-based numbers with a merchant or service prefix and a destination country
suffix; no rule claims those, since each prefix has too few samples to tell its issuer. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

`tracker.janio.asia/{number}` opens one parcel: the tracker reads the number from the first
path segment.

## Testing

`npm run test:carriers:live -- carriers/janio`, with `JANIO_TRACKING_NUMBER` and optionally
`JANIO_UNKNOWN_NUMBER` set outside the repository.
