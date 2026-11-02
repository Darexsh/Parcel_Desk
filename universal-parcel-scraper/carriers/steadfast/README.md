# Steadfast Courier

Steadfast Courier parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Steadfast tracking codes come in two layouts. Older consignments have eight to eleven
hexadecimal characters; newer ones are `SFR`, the creation date as two-digit year, month and
day, `ST` and nine hexadecimal characters. `steadfast-1` claims the newer layout. Short
hexadecimal codes are too generic to claim.

## Links

Older addresses, `steadfast.com.bd/t/{code}` with a hexadecimal code and
`steadfast.com.bd/track/consignment/{code}`, carry the tracking code, and the library reads it
from them. Text messages link to `/t/` or `/tl/` with a longer private code, which is not a
tracking number and is not read.

## Limitations

Steadfast's tracking page opens a parcel only from the private code in the recipient's text
message. With a tracking code, `/t/` and `/tl/` answer that the link is not available, and
`steadfast.com.bd/track/consignment/{code}` answers "Consignment not found!" for every code,
current parcels included. The Steadfast Courier app is the merchant app and needs an account,
and the merchant API needs the merchant's keys, so Steadfast stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
