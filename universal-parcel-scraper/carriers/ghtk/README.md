# GHTK

Giao Hàng Tiết Kiệm (GHTK) parcels use enabled universal providers. There is no dedicated
adapter.

## Numbers

GHTK labels print a code made of `S` and the shop's number, sorting codes and the order number,
separated by dots, such as lookups archived from GHTK's tracker show. `ghtk-1` claims that
code. The tracker also takes the order number alone, nine or ten digits, which other carriers
print too, so no rule claims it.

## Links

GHTK's tracker opens one parcel at `i.ghtk.vn/{number}`, and the library reads the number from
that address.

## Why there is no adapter

The tracker reads `iggw-service.giaohangtietkiem.vn/api/v2/package-tracking/get-package` with
the whole number in `q`, using `RType: score` and a fresh reCAPTCHA token in `RToken`. An
invalid score opens a checkbox and repeats the request with `RType: checkbox`. Without the
headers the service answers `illegal_request_param`, and without a valid token
`invalid_captcha`, for made-up numbers too, so neither reply says anything about the number.
TRAWL can capture both replies; verification refusals must remain in that sequence. The service
limits tracking to six months and reports expired history as a service error, rather than a
missing parcel. Additional details require the tracking session returned by a successful lookup.

The iGHTK Android app (`vn.ghtk.ightk.ez`) opens only with a phone-number login, and its parcel
lists and details need that session. It never calls the tracker's lookup, so GHTK stays on
universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
