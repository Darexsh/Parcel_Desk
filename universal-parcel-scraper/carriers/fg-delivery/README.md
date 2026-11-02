# FG Delivery

FG Delivery is the parcel brand of Fulmine Group, an Italian postal operator, and delivers
e-commerce parcels through its own branches, AliExpress orders among them. Tracked through
the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://tracking.fgdelivery.it/GetTrack?IdSpedizione={number}`, the
   request the tracking page's script sends. It needs no cookie, token, key, postcode or
   browser. The JSON reply is a list with one row per scan, numbered by `Progressivo` from the
   newest.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try
   gets half of the budget.

- An unknown number gets an empty list. The page shows a generic error for it, and FG
  Delivery's help centre says a parcel it cannot find has not reached its national hub yet. A
  404 or a redirect is a moved route.
- The tracking host's FortiWeb firewall answers a refused request with a "Web Page Blocked"
  page, which the adapter reports as a challenge.
- The tracker finds a row by its shipment's number (`IdSpedizione`), the sender's reference
  (`RiferimentoCliente`) or a second barcode (`Barcode2`), matching the whole value in upper
  or lower case. An FGD number must be the shipment's own. A Cainiao code may be any of the
  three, and the result then names the FGD number as the canonical one. A reference several
  shipments share is inconclusive.
- Recognition makes the same request.

## Notes

- Each scan's `DataConsegna` is month, day and year, and `OraConsegna` the clock to the
  second. Each row also names a `TimeZone`, `GMT+01:00` on every row seen, all of them in
  winter, so whether it follows summer time is unknown and the clocks stay `local_time`.
- The scan's `EventCode` stages it. A code no reply has shown falls to FG Delivery's own
  wordings for a missed round ("lasciato avviso", "Non in casa", "Indirizzo non trovato"),
  then to the shared wording rules.
- The page shows only the newest scan's wording and date. The reply also carries the full
  history, the recipient's postcode, name and delivery notes, and the sender's reference.
  The history and codes are kept; the rest is not.
- The reply names no other carrier, and nothing in it hands the parcel on.

## Limitations

- No location, delivery estimate or weight, and no clock as an instant.
- The tracker also answers senders' own references, which can be anything, so the adapter
  asks it only for the two number shapes below.

## Numbers

FG Delivery's own shipment code is FGD and twenty-two digits: its help centre says the code
starts with FGD and shows it printed under the label's barcode. `fg-delivery-fgd` claims it.

AliExpress parcels it delivers carry Cainiao's Italian codes: CNIT, two letters, eight digits
and the suffix FLM, which names Fulmine. Customers quote them in complaints the company
answers. `fg-delivery-1` claims that layout. The public samples are older parcels the tracker
no longer finds, so they stay quarantined until a current one shows that it keys Cainiao's
codes. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page reads the number from its `barcode` parameter and looks it up at once, so
`fgdelivery.it/tracciabilita/?barcode={number}` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/fg-delivery`, with `FG_DELIVERY_TRACKING_NUMBER` and
optionally `FG_DELIVERY_UNKNOWN_NUMBER` set outside the repository.
