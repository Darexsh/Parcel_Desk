# Fixtures

`delivered.json` and `in-transit.json` follow the reply of Shipsy's `consignment/track` for
Chronodiali's account, newest scan first, with every field the live reply has.
`delivered.json` goes from the merchant's data upload to a delivery with a courier's call before
it, one hub scan relayed twice, and carries the sender's and recipient's names, phones and
addresses, a cash-on-delivery amount, the courier, GPS positions, a delivery trip and proof
images. `in-transit.json` is a parcel from abroad waiting for customs at the partner hub.
`not-found.json` is the HTTP 400 answer for a number Chronodiali does not know.

Numbers, names, phones, places, amounts and clocks are invented.
