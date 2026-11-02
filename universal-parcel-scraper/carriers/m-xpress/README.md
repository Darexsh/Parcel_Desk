# M Xpress

M Xpress parcels use enabled universal providers. There is no dedicated adapter.

M Xpress (M Xpress Sdn Bhd), formerly Sure-Reach Worldwide Express, is a Petaling Jaya courier delivering
same-day and next-day parcels in Malaysia; it now puts its weight on transport, relocation and freight. Its site
is mxpress2u.com. sure-reach.com now belongs to an unrelated records-management business.

## Numbers

No public page shows an M Xpress number. An old Sure-Reach consignment-note guide prints the note number as two
digits, a hyphen and six digits, which its barcode gives as seven digits. Runs of digits that short are shared
by other carriers, so there is no rule. The tracker also takes shippers' references.

## Why there is no adapter

Its tracker posts the numbers to an open JSON endpoint without a login or CAPTCHA:
`POST goldv2.mxpress2u.net/goldv2webtracking/TrackShipment`, with the antiforgery token its page and cookie
carry. The host resets connections from outside Malaysia, so an adapter would need a Malaysian network path. No
public number is known to see a reply.

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
