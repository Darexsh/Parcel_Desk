# Fixtures

`delivered.json`, `exported.json`, `abroad.json` and `inbound.json` follow the shape of the
lookup's reply: the item code, the case and the five steps, each with the newest scan the item had
in it or nothing. `delivered.json` is a domestic item delivered in Egypt, `exported.json` an item
handed to the international transporter, `abroad.json` one scanned and delivered in another
country and `inbound.json` mail from abroad brought back to the office after a delivery round.
`not-found.json` is the reply for an unknown code and `incorrect.json` the one for a code of the
wrong length. Codes, offices, towns, countries and clocks are invented.
