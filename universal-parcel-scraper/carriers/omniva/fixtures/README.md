# Fixtures

`collected.json`, `customs.json`, `courier.json`, `returned.json` and `summary.json` follow the
shape of the app's guest tracking reply: the item's state, delivery channel and chosen site,
and its scans in no set order, each with an event code, English wording, a UTC clock, a site and
event parameters. Numbers, names, sites, postcodes, phone numbers and clocks are invented.
`not-found.json` is the reply for a number the service does not know.
