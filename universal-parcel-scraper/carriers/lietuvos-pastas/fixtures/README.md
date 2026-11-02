# Fixtures

`locker.json`, `abroad.json` and `returned.json` follow the shape of the self-service API's
second tracking version: the mail known under the number and its rows, each with a public event
type and state, English wording, a clock labeled with Vilnius's offset, a country and often a
place. `returned.json` also carries a return label's mail, which the tracking page leaves out.
Numbers, identifiers, lockers, offices, streets, postcodes and clocks are invented.
`not-found.json` is the answer for a number the service does not know, and `no-history.json`
for one it knows without rows.
