# Best Transport

Best Transport parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Best's tracker asks for the shipment number. Archived lookups on it show thirteen characters
starting `DLT` and eight digits; Best does not publish its layouts. The tracker also answers
for some partners' shipments, so the `DLT` layout stays unclaimed, and eight digits are shared
by many carriers.

## Why there is no adapter

The tracker posts the number as `freightbill` to `POST bst.nu/api/app/search`, without a login or
CAPTCHA, and answers a number it does not find with HTTP 404 and a generic message. It no longer
finds the archived numbers, and no public number it still knows has been found. It also relays
some partners' shipments, such as Schenker's, under their own reply.

## Links

The tracker at `bst.nu` runs its search for the number in `search`, with or without a country
segment such as `/SE`, so `bst.nu/?search={number}` opens one shipment. A delivery page under
`bst.nu/{country}/{token}` uses a token, not the number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
