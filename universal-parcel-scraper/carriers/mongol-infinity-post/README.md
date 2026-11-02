# Mongol Infinity Post

Mongol Infinity Post (Монгол Инфинити Шуудан, brand MyPost) is a private postal and express
operator in Mongolia, with first- and last-mile delivery, branches and a fulfilment centre
for online shops. Tracked through the search its home page makes.

## How it works

1. `direct`: one `GET https://mypost.mn/core_api/api/order/history?q={number}`, as the home
   page's parcel search sends it. It needs no cookie, token, key or browser. The JSON reply is
   a list of search hits, one per scan, each with the whole order around it.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- For a number holding `YC` the page asks
  `GET https://mypost.mn/order_api/api/customs/admin/status/item/{number}` instead, and so does
  the adapter. That reply is one item with its customs statuses.
- No hit is the page's not-found answer. The customs lookup answers an item it does not know
  with HTTP 404 and a message naming the number. Any other 404, and a redirect, is a moved
  route.
- The search can hit other parcels. A hit counts only when its barcode is the number asked, or
  its order id for a seven-digit number. An order id whose hits name several barcodes is
  inconclusive (`several_parcels`). Looked up by its order id, a parcel reports its barcode as
  `canonical_tracking_number`. The customs item must name the number asked.
- Recognition makes the same request.

## Notes

- Scan times are the reply's own UTC instants, to the millisecond, and are kept as instants.
  Read at Ulaanbaatar's offset, the status table's edit stamps fall in working hours.
- A scan's description is its status's name, with the reason a failed delivery gives, without
  phone numbers. The status's code (`EMB`, `EMI`) stages it.
- A scan's location is its branch, town and country, in English when the reply has it. The page
  leaves the branch out once the parcel is with the courier, delivered or sent back, and so
  does the adapter.
- Each hit also carries the sender, the recipient with their phones, address and position, the
  couriers, the staff member, the recipient's signature and the declared goods. None of it is
  read. The scan's own note repeats its status and is not shown.
- The customs reply's mail, order, bag and bill-of-lading references are not kept.

## Limitations

- No estimate, weight or proof of delivery.
- The search returns its hits in one page whose size the adapter cannot change.

## Numbers

The home page's search asks for the parcel's registration number. Its examples are a
seven-digit number, two letters with eight digits and `MN`, and a number starting with `YC`.
The seven digits are an order id: the search answers it with a parcel's history, which names
the parcel's barcode in the second example's shape. That barcode is one digit short of a UPU
S10 number. Seven bare digits are a shape many carriers share, so no rule claims them, and
without a rule of its own Mongol Infinity Post is not asked during recognition. The adapter
sends order ids, barcodes and customs numbers.

## Links

The home-page search shows the result in the page without changing its address. The site's
`/item/{number}` page lists a parcel's declared contents rather than its history, so no
address opens one parcel's tracking.

## Testing

`npm run test:carriers:live -- carriers/mongol-infinity-post`, with
`MONGOL_INFINITY_POST_TRACKING_NUMBER` and optionally `MONGOL_INFINITY_POST_BARCODE_NUMBER` for
that parcel's barcode, `MONGOL_INFINITY_POST_UNKNOWN_NUMBER`, `MONGOL_INFINITY_POST_CUSTOMS_NUMBER`
and `MONGOL_INFINITY_POST_CUSTOMS_UNKNOWN_NUMBER` set outside the repository.
