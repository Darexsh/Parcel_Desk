# M24 Logistics

M24 Logistics parcels use enabled universal providers. There is no dedicated adapter.

M24 Logistics, a division of Media24, handles online shops' orders in South Africa and hands them to
partner couriers for the last mile. Its site is m24logistics.com.

## Numbers

Its tracker takes M24's own parcel and shipment numbers, its invoice numbers or the shop's order
reference, and its placeholder is a letter and nine digits. No public page shows an M24 number, so
there is no rule.

## Why there is no adapter

Its tracker answers through a page action bound to each deployment of the site, without a login or
CAPTCHA.

## Links

Tracking links carry the number in the path after `/track-my-order/` on lms.m24logistics.com.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
