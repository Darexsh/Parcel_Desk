# HepsiJET

HepsiJET is the delivery company of Hepsiburada, a large Turkish marketplace. It delivers
marketplace orders and parcels from other web shops across Turkey, and collects customers'
returns. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://website-backend.hepsijet.com/server/tms/webDeliveryTracking?customerDeliveryNo={number}`,
   as the tracking page at `www.hepsijet.com/gonderi-takibi/{number}` sends it. It needs no
   cookie, token, key or browser. The JSON reply has the shipment's summary and its scans,
   oldest first.
2. `retry`: the same request once more when the first failed to reach HepsiJET or hung.

- An unknown number is HTTP 200 with `"status":"FAIL"` and
  `"detailStatus":"DELIVERY_BARCODE_NOT_FOUND"`. Another `FAIL` is inconclusive.
- `"status":"OK"` without a shipment and with `params.IsNeo` is a number HepsiJET has no parcel
  for yet; the page says tracking starts once the parcel is collected. The adapter reports no
  history.
- The shipment must carry the number asked, as its own number or its barcode.
- Hepsiburada's Akamai edge refuses some clients with its security page and HTTP 403, curl and
  its User-Agent among them. Node's client with the package's User-Agent passes. The adapter
  reports the page as a challenge.
- Recognition makes the same request.

## Notes

- Each scan's `transactionDateTime` carries its offset, so scans are instants. A clock that came
  without one would be read in Istanbul, where HepsiJET scans.
- A scan's `deliveryStatus` (`DELIVERING`) is its code and stages it. `DELIVERED` is also the
  status of a parcel handed back to its sender, which its wording says (`İade Edildi`), so that
  wording reads as returned.
- The wording of a delivery or a collection names the person who took or handed over the parcel
  after a dash, unmasked at times; the adapter drops it. A failed delivery or collection gets the
  reply's reason after a colon, as in `Teslim Edilemedi: Hasarlı`.
- Scans placed with the recipient, with the sender or in the delivery van have no location.
- The estimate is the promised delivery day. A customer's return has a collection day instead,
  which is not kept.
- The recipient's masked name and address, the sender, the person who took the parcel and the
  merchant account in the reply are not kept. The page's courier map comes from a second
  request that the adapter does not make.

## Limitations

- No weight: the reply has only the volumetric `desi`.
- A parcel sent to a delivery point names the point on the page; the adapter does not read it.
- The lookup matches letters' case. The library sends numbers in capitals, which is how the
  tracker stores the codes seen so far.

## Numbers

HepsiJET tracks the codes its merchants put on their labels, so the numbers have many layouts:
twelve letters and digits, `KJET` codes, merchant prefixes such as `ITX`, `GLV` or `oto`
followed by digits, `HM` codes ending `TR`, and plain runs of twelve or fourteen digits.
Prefixes belong to merchants and digit runs are shared with other carriers, so no rule claims
them. The adapter takes eight to thirty letters and digits.

## Links

The tracker shows one parcel at `www.hepsijet.com/gonderi-takibi/{number}`, and archived
lookups also use `coklu-gonderi-takibi`, its multi-shipment page, with one number. The library
reads the number from both and links the first.

## Testing

`npm run test:carriers:live -- carriers/hepsijet`, with `HEPSIJET_TRACKING_NUMBER` and
optionally `HEPSIJET_UNKNOWN_NUMBER` set outside the repository.
