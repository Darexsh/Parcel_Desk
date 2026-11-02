# Danske Fragtmænd

Danske Fragtmænd is a Danish freight network that collects and delivers pallets and parcels for
businesses and private recipients across Denmark. Tracked through the lookups its tracking page
on trace.fragt.dk makes.

## How it works

1. `direct`: one `GET https://trace.fragt.dk/backend/api/tracktrace/GetByConsignmentNumber?consignmentNumber={number}&language=2`
   for a consignment note number, or `GetByColliCode?colliCode={collicode}&language=2` for a
   collicode, as the page sends them. `language=2` is the page's English. Neither needs a
   cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The JSON reply has the consignment note and its scans, newest first. An unknown number is
  HTTP 404 with a `Message` naming that number, which is not found. Any other 404 or a redirect
  is a moved route. A 400 calling the collicode invalid is invalid input.
- The consignment note must carry the number asked. A collicode ends with its note's number,
  and the note must list the collicode among its parcels when it lists any.
- Recognition makes the same request, for a collicode only.

## Notes

- Scan dates are Danish wall clocks without an offset, read in Europe/Copenhagen. Archived
  replies place them after the capture time when read as UTC.
- The `EventCode` (`LEV`) stages a scan. An unmapped code takes the delivered or cancelled icon
  the page draws for the scan's `Status`, then the shared wording rules.
- Consignment note numbers come back into use. One archived reply listed a scan from years
  before the note's date, so a scan more than 30 days older than the note's date is left out.
- The delivery windows a sender books (`DO1` to `DO4`, `SDL`) are left out: the page shows them
  undated, in a sentence of its own.
- A cancelled consignment (`State` `Annulleret`) takes the page's notice over its scans, and is
  returned without scans when it has none.
- The expected day is the note's `ExpectedDeliveryDate`, kept until the delivery. The reply's
  `ActualDeliveryDate` can be a failed attempt's time, so the delivery time comes from the
  delivery scan. The weight is the total of the goods lines.
- For a collicode, the consignment note number is the canonical number.
- Delivery scans can carry the delivery's coordinates, which point at the recipient's address
  and are not kept. Neither are the goods, their value, the sender's reference, the driver and
  route numbers, or the per-parcel scans the page shows separately.

## Limitations

- No sender, recipient, pickup point or service name: the anonymous reply has none.
- The reply names a partner that delivers for Danske Fragtmænd, such as PostNord, but not the
  partner's number, so there is no hand-off.
- `trace.fragt.dk/{number}` opens a consignment note number. A collicode opens only under
  `trace.fragt.dk/colli/{collicode}`.

## Numbers

Danske Fragtmænd's FAQ says a consignment note number is two letters and six digits; its
integration guide and archived tracker replies show the same layout. Each parcel also carries a
collicode of twenty digits followed by the consignment note number, which the tracker accepts
too. The adapter takes both; anything else is invalid without a request.

`danske-fragtmaend-1` claims the collicode, which no other carrier prints. No rule claims the
consignment note number on its own: two letters and six digits also fit other carriers'
numbers, the eight characters the three GLS networks print among them. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

Danske Fragtmænd's integration guide documents `trace.fragt.dk/{number}` for a consignment note
number and `trace.fragt.dk/colli/{collicode}` for a parcel. Both redirect to the page's own
`#/trackTrace/` route.

## Testing

`npm run test:carriers:live -- carriers/danske-fragtmaend`, with
`DANSKE_FRAGTMAEND_TRACKING_NUMBER` (a collicode or a consignment note number) and optionally
`DANSKE_FRAGTMAEND_UNKNOWN_NUMBER` set outside the repository.
