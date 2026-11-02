# BEST Express Malaysia

BEST Express Malaysia parcels use enabled universal providers. There is no dedicated adapter.

BEST Express Malaysia is the Malaysian parcel network of BEST Inc. It runs its own tracker at
best-inc.my, a separate site from the Vietnamese one that `best-express-vn` covers, on the
same build.

## Numbers

An archived lookup on the tracker shows a fourteen-digit waybill that starts with 6085.
BEST's Thai and Vietnamese waybills archived on their trackers have the same length and start
with their own country calling code and 85, so `best-express-my-1` suggests BEST Express
Malaysia for this prefix at low confidence: other carriers also print fourteen digits.

## Links

`best-inc.my/track?bills={number}` opens the tracker with the number filled in; the site's
tracking form builds that address, and archived lookups use it.

## Why there is no adapter

The tracker runs on the same build as BEST Express Vietnam's and posts the waybills to
`www.best-inc.my/express-cc/express/expresslistinfo`. Without a solved captcha the gateway
answers `risk_001`, "request has risk", for every lookup, from a browser's headers or the
BEST apps' alike, and the page then shows BEST's own captcha, a picture to slide into place.
The variant with a phone step answers "Forbidden". So BEST Express Malaysia stays on universal
providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
