# BEX Express

BEX Express is a Serbian courier that delivers across Serbia, including parcels that arrive
from abroad and clear customs. Tracked through the history lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://integrations.bexexpress.rs/api/Shipments/shipmentHistory?trackingValue={number}`
   with the `X-Auth-Token` header the tracking page's script sends. The token is the same for
   every visitor, so the lookup needs no account, cookie or browser. The page loads reCAPTCHA
   but sends no token from it. The JSON reply has the scans, oldest first, and a summary.
2. `retry`: one more try when the request fails to reach the service or hangs. The first try
   gets half of the budget.

- An unknown number is HTTP 400 with the message "Shipment with provided trackingValue doesn't
  exist". Another HTTP 400 is a refused request, HTTP 401 a refused token, and a 404 or a
  redirect a moved route.
- Every scan's `shipmentId` must be the number asked.
- Recognition makes the same request.

## Notes

- Each scan has a status code and the code of the barcode scan that set it. Its wording is the
  label the tracking page's script gives the pair, which names the delivery round, a failed
  delivery, a Paket Shop or customs. The provider code is the status, then the scan after a
  colon when it is not 0. The page shows those labels only for parcels from abroad and the bare
  status names otherwise, but the scan codes are the same.
- A scan's `timeStamp` is a wall clock and `timeZone` its offset, as "GMT+1". The API
  documentation gives it as the zone of the timestamp, so the clocks are instants. A scan
  without a usable offset keeps its wall clock.
- A scan of a status the page names, with a scan code the map does not know, keeps the page's
  label and no stage. The cash on delivery waiting for or paid out to the sender comes after
  the delivery and moves nothing. The page hides status -41, and so does the adapter.
- The summary, `eventPrediction`, gives the masked recipient name, town and phone number, the
  courier's notes, a delivery estimate in words and the bank account the cash on delivery was
  paid to. None of it is kept.
- The reply names no partner network or partner number, so there is no hand-off.

## Limitations

- No dated delivery estimate, pickup point, service or weight.
- The page refuses numbers below its current series as an earlier year's and asks the visitor
  to contact BEX. The adapter still asks the service, which may no longer know them.

## Numbers

BEX Express shipment numbers have nine digits, as its tracking form's example and every
shipment the service names show. Nine digits are shared with other carriers, so no rule claims
them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page reads the number from `broj-posiljke` and looks it up when it opens.

## Testing

`npm run test:carriers:live -- carriers/bex-express`, with `BEX_EXPRESS_TRACKING_NUMBER` and
optionally `BEX_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
