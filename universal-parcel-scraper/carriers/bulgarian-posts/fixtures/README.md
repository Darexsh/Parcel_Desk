# Fixtures

Every fixture follows the shape of the reply the tracking page's
`GET /api/trace/parcel/{number}?language=EN` gives: the scans oldest first, each with its wall
clock, an empty post code, its country and office, a zero event code, its event name, a zero
status code, its detail and an empty note, then the `bulpost` flag and its empty page.

- `delivered.json`: mail from abroad, with the sending post's scans, customs and its collection
  from a post office.
- `customs.json`: mail from abroad held at customs.
- `outbound.json`: an item posted in Bulgaria, up to the office of exchange that sends it abroad.
- `domestic.json`: domestic scans, in Bulgarian, waiting at a post office for collection.
- `not-found.json`: the reply for a number the tracker holds nothing for.
- `wrong-code.json`: the reply for a code the tracker cannot read.

Numbers, offices, postcodes, towns and clocks are invented.
