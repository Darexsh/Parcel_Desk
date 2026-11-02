# V-Xpress

V-Xpress parcels use enabled universal providers. There is no dedicated adapter.

V-Xpress is the express cargo division of V-Trans (India) Ltd., carrying parcels by road, air and multimodal
services across India from its own branches. Its site is vxpress.in.

## Numbers

Its docket numbers are seven digits in a customer's complaint. Seven bare digits are shared by other carriers,
so there is no rule. Its tracking page warns that the docket number differs from a shop's order number.

## Why there is no adapter

Its tracking page posts the docket number to an open endpoint without a session or CAPTCHA:
`POST vxpress.in/sx_trackapi_new.php` with `iTrackingNumber` and `isTrace=1`, which returns an HTML fragment. An
unknown number gets HTTP 200 with a "Docket Number Not Found" message. The reply allows public caching for
a month, so an adapter has to bypass shared caches. It does not find the public docket, which is old, so no found
reply has been seen.

## Links

Its tracker has no address for a single number: `/track/<number>/` on its site only pages through the track
page, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
