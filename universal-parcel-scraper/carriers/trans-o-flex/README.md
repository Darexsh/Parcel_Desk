# trans-o-flex

trans-o-flex parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

trans-o-flex support quoted two numbers on the O2 help forum, each eleven digits, a hyphen and
thirteen digits. Shippers' links to the tracker pass the same barcode as twenty-four digits,
which end in `49` and the five-digit delivery postcode. Twenty-four digits is a length other
carriers share, so no rule claims them; a pasted tracker link names trans-o-flex.

## Links

The guest tracker at `www.trans-o-flex.com/sendungsverfolgung/tracking` takes the number as
`ref` with `type=barcode`, and fills it into its form. The visitor still types the delivery
postcode and house number. A first visit shows the terms of use with a reCAPTCHA checkbox; the
page only stores that they were accepted, and its lookups carry no token.

## Why there is no adapter

The tracker is the web version of the trans-o-flex insight receiver app. Its guest search calls
`GET insight.tof.de/tracking/v2/shipments` with `ref`, `type`, `zip`, `streetno`, `lang` and
`detailed`. Without both a postcode and a house number the service answers HTTP 404 "Diese
Sendungsnummer ist mehrfach vergeben" and asks for them, for unknown numbers too, so that reply
says nothing about the number. With both, an unknown number and a wrong address get the same
"keine Sendungsdaten gefunden" notice. trans-o-flex describes the postcode and house number as
the verification for guest tracking; signed-in tracking needs an account activated with a TAN
sent by post.

The Android app (`com.tof.app`) is the same client, and the build on APKPure still calls the
retired `tracking/v1`. The sender portal `my.tof.de` needs a customer login, and the former
tracker on `track.tof.de` no longer answers. The barcode carries the postcode but not the house
number, which the parcel form does not collect, so trans-o-flex stays on universal providers.
A shipper's link that includes `zip` and `streetno` could serve as a tracking-URL input once a
live one shows the result.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
