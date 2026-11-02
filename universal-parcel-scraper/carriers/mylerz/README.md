# Mylerz

Mylerz is an e-commerce courier from Cairo that collects parcels from online shops and delivers
them, often against cash, in Egypt, Morocco, Algeria, Tunisia and Jordan. Tracked through the
API its tracker calls.

## How it works

1. `direct`: `GET https://api.mylerz.net/api/package/GetPackageTrackingDetailsByBarCode?barcode={number}`,
   as the tracker on mylerz.net sends it. It needs no cookie, token, key or browser. The JSON
   reply has the shipment's details and its status log, newest first.
2. `retry`: after a failed connection or a timeout, the same lookup once more. The first gets
   half of the budget.

- Each country runs its own instance with its own parcels: Egypt's answers `api.mylerz.net`,
  Morocco's, Algeria's and Jordan's `api.{country}.mylerz.net`. Egypt's is asked first; when it
  does not know the barcode, the other three are asked at once.
- An unknown barcode is HTTP 200 with `IsErrorState` and `ErrorDescription` `NOT_FOUND`. The
  parcel is not found only when every instance says so. An instance also reports its own
  failures that way, such as a database it cannot reach, so any other description is
  inconclusive. A history from one instance stands over the others' failures; histories from
  two instances are inconclusive.
- A 404 or a redirect is a moved route. A 403 or a bot check in place of the JSON is a
  challenge.
- The shipment's `Barcode` must be the barcode asked.
- Recognition makes the same lookup.

## Notes

- A scan shows its consumer status, `StatusBusId` and its English name, as the tracker does;
  the code stages it. The internal status beside it is used as wording only for a scan without
  a consumer status, and stages nothing: `Received by Myler` names both the pickup and the
  delivery courier.
- `ChangedDate` is a wall clock with a fraction of a second and no zone, and neither the reply
  nor the tracker says which zone it is. Scans keep it as `local_time`, to the second.
- The address, the courier's name, phone number and picture, the call log and text messages,
  the merchant, the cash to collect, the payment type, the preferred delivery time, the hubs and
  the piece count in the reply are not kept.

## Limitations

- Tunisia's instance accepts no connection, so it is not asked, and a Tunisian parcel reads as
  not found. The instance at `api.msc.mylerz.net` answers with a database error or not at all,
  and is not asked either.
- Histories have been seen only from Egypt's instance. The other countries' replies are assumed
  to use the same statuses, and their clocks may be their own country's.
- Barcodes archived in earlier years answer not found.
- No scan location, weight or delivery estimate.
- The tracker also looks up merchants' own references, which the adapter does not.

## Numbers

Mylerz barcodes are fourteen digits starting `63`. Its tracker's script reads exactly that
shape as a barcode and sends anything else to its reference search. Archived lookups on the
tracker and its tracking API show the same shape. `mylerz-1` suggests Mylerz for it with low
confidence: fourteen-digit numbers are also printed by the DPD networks and other carriers.
Recognition asks Mylerz after the DPD networks. The tracker's field also accepts `MYLE` and
nine digits, a layout no public number shows, so no rule claims it.

## Links

The tracker opens one barcode from `mylerz.net/track/{number}`, the address its own search
navigates to. Archived links put the barcode in the path of `mylerz.net/trackShipment/` and
`mylerz.net/track-details/`; the library reads the number from all three.

## Testing

`npm run test:carriers:live -- carriers/mylerz`, with `MYLERZ_TRACKING_NUMBER` and optionally
`MYLERZ_UNKNOWN_NUMBER` set outside the repository.
