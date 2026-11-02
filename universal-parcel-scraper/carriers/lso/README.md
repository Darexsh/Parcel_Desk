# LSO

Lone Star Overnight parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

LSO airbills are eight letters and digits starting `ZY0`, such as `ZY0FZ3UD`. A review and
LSO's reply on Trustpilot give two. `lso-1` claims the `ZY0` prefix; other eight-character
shapes stay with the carriers that already share them.

## Links

LSO's tracking page reads airbill numbers from `?airbillnos=` on `lso.com/tracking` and hands
them to its tracker on `app.lso.com`.

## Why there is no adapter

The tracker on `app.lso.com` is a single-page app whose only tracking read is an anonymous
`GET https://api-prod.lso.com/tracking/track_barcode?barcodes=` with one airbill or several
separated by commas. It sends no token, cookie or CAPTCHA. The page expects a `message` list
with one entry per number: `SearchBarcode` and a `Package` holding `airbillno`,
`overallstatus`, a `badpackage` flag for a number it could not track, `packagedetails` (the
delivery date, the signer and the recipient's address) and `scanevents` (`statuscode`,
`statusdescription`, `city` and `eventtimestamp`, which it shows in Central time).

That service answers every number, an airbill or not, with HTTP 500 and
`{"message": "Internal Server Error"}`, from European and US networks alike, and the official
page then shows "There seems to be a problem getting the tracking details". The same API's
other data reads, such as fuel surcharges and drop boxes, time out, so the fault lies behind
the API rather than in the request. An adapter needs that service to answer again and a
current airbill to confirm its reply, its clocks and its not-found case.

LSO publishes no consumer app on Google Play or the App Store, and its site links no other
public tracker.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
