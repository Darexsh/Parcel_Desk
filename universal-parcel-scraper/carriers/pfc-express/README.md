# PFC Express

PFC Express (皇家物流, Shenzhen Royal Logistics) is a Shenzhen fulfilment and cross-border
shipping company. It collects merchants' parcels in China and sends them on its own channels,
whose last leg is a post or courier in the destination country, or through China Post. Tracked
through the lookup its tracking page at `pfctrack.com` makes.

## How it works

1. `direct`: one `GET https://www.pfctrack.com/Index?handler=AccessRedirect&nos={number},&language=cn`,
   as the tracking page's script sends it. It needs no cookie, token, key or browser. The reply
   is a JSON string holding an HTML fragment with one item per number asked.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- A parcel's item names its reference, its tracking number, PFC's order number, its channel, its
  origin and destination and its scans, newest first. It is classed by the tracker's tab:
  `Processing`, `Transit`, `Alert` or `Delivered`.
- A number the tracker does not know gets an item classed `NOT` that echoes the number and says
  "Not Found". The service answers HTTP 200 for every number, so a 404 or a redirect is a moved
  route, and an empty string, its answer to a request without a number, is inconclusive.
- The item must name the whole number asked in one of its number columns.
- `language=cn` is the page's default and keeps each scan's own wording. The page's translate
  link sends `language=en`, which asks for Chinese.
- Recognition makes the same request.

## Notes

- Scan clocks are wall clocks to the second, with no zone, written month first. Relayed scans
  abroad can be on Beijing's clock: a USPS partner scan in PFC's history reads fifteen hours
  ahead of the same scan on USPS's tracker. Nothing in the reply says which scans are, so every
  clock stays `local_time`.
- The tracking number is the delivering carrier's, such as a destination post's S10 number or a
  USPS barcode, and becomes the delivery tracking number. The reply names only PFC's channel
  code (`service_name`), not the carrier, so there is no delivery carrier.
- The tab settles a delivery or a held parcel (`Alert`). Otherwise the newest scan with a stage
  decides, and `Transit` only when no scan has one.
- The tracker relays the delivering carrier's scans, including China Post's in Chinese. Those
  name couriers and give their phones and hotlines in later clauses and brackets: the adapter
  keeps a Chinese scan's clauses up to the first contact, and only brackets that name an office.
  Every scan loses phone numbers, e-mail addresses and who signed.
- The place after a scan's `----` is its location. The older inquiry page put a facility code
  and a comma before some wordings instead, which the adapter reads the same way.
- The merchant's reference and the origin are not kept.

## Limitations

- No delivery estimate, weight, sender or recipient, and no delivery time as an instant.

## Numbers

PFC's order numbers read `R`, the customer's five- or six-digit account, the order date as
`yyMMdd` and a serial, padded to four digits in older numbers and unpadded in newer ones. The
adapter asks the tracker only about order numbers.

A low-confidence rule suggests order numbers from fourteen characters on. Colis Privé's
seventeen-character rule also fits many of them. A five-digit account with a one-digit serial
makes thirteen characters, which La Poste's rule also takes, so those need PFC chosen or a
tracking link. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker reads numbers from `nums` or `no` and writes `?nums=` back after a search, so
`www.pfctrack.com/?nums={number}` opens a lookup. The older inquiry page on `pfcexpress.com`
read `txtID` and now redirects to the tracker.

## Testing

`npm run test:carriers:live -- carriers/pfc-express`, with `PFC_EXPRESS_TRACKING_NUMBER` and
optionally `PFC_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
