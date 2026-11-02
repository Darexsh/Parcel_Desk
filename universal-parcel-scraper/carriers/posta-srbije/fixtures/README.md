# Fixtures

`abroad.json` and `returned.json` follow the shape of the app service's answer for an item: a
result code, the item's events newest first and an empty notice. The service sends the events and
the notice as JSON text; the fixtures keep them as objects and the tests encode them. Each event
has the service's codes, English wording, an offset-less clock, the office with its number or a
foreign post's country and office code, the office it goes to, the phase, the return flag, the
weight and the signer. Numbers, offices, office codes, postcodes, signers and clocks are invented.
`not-found.json` is the answer for a number the service does not know, and `refused.json` the
answer to a wrong app password.
