# Fixtures

`collected.json`, `returned.json` and `pre-advice.json` follow the shape of the B2C tracking
service's JSON answer: one item with its attributes and its rows, each with a state code, a
calendar day, English wording, a postcode, an office, coordinates and an attempt time. Rows are
in the service's own loose order. Numbers, offices, postcodes, coordinates, phone numbers and
days are invented. `not-found.json` is the answer for a number the service does not know.
