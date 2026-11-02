# GHN

Giao Hàng Nhanh (GHN) parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

GHN order codes, which GHN's API calls its tracking code, are eight letters and digits;
lookups archived from GHN's tracker show them starting `G`, and a few older ones nine or ten
characters. Eight-character codes are also GLS's layout, so no rule claims them.

## Links

GHN's site opens its tracker as `donhang.ghn.vn/?order_code={number}`, and the library reads
the number from that address.

## Why there is no adapter

The tracker asks for the order code and the sender's or recipient's phone number, or its last
four digits. Its lookup, `POST fe-online-gateway.ghn.vn/order-tracking/public-api/client/tracking-logs`,
takes `order_code` and `phone_verify`, a SHA-256 hash of the code and that phone number.
Without the hash the service answers `PHONE_VERIFY_REQUIRED`, and with a wrong one
`PHONE_VERIFY_FAIL`, for made-up codes too, so neither reply says anything about the number.
The call, SMS and order-log lookups beside it make the same check. The page skips the phone
prompt only when a shop's GHN account opens it with a session token.

The GHN Android app (`vn.ghn.app.giaohangnhanh`) is the shop app, and its order history needs
an account's authorization. The library takes no phone number, so GHN stays on universal
providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
