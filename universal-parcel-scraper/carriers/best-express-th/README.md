# BEST Express Thailand

BEST Express Thailand parcels use enabled universal providers. There is no dedicated adapter.

BEST Express Thailand is the Thai parcel network of BEST Inc. It runs its own tracker at best-inc.co.th, on the
same build as BEST Express Malaysia's and BEST Express Vietnam's.

## Numbers

Archived lookups on the tracker show fourteen-digit waybills that start with 6685, Thailand's calling code and
85, as BEST Express Malaysia's start with 6085. `best-express-th-1` suggests BEST Express Thailand for this
prefix at low confidence: other carriers also print fourteen digits, and every example comes from the tracker's
archived addresses.

## Why there is no adapter

The tracker posts the waybills to `www.best-inc.co.th/express-cc/express/expresslistinfo`. Without a solved
captcha the gateway answers `risk_001`, "request has risk", for every lookup, and the page then shows BEST's
own captcha, a picture to rotate upright. So BEST Express Thailand stays on universal providers.

## Links

`best-inc.co.th/track?bills={number}` opens the tracker with the number filled in; the tracker also reads
`waybill`, and its mobile page, `/wapp/track`, takes either.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
