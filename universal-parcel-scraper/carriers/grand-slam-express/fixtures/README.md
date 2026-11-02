# Fixtures

`delivered.html` and `in-transit.html` are the HTML that `Web/AwbNoTracking` on
`www.grandslamexpress.in` returns in its reply's `Result` for one AWB number, which the tests
wrap in the reply's `Error`, `Data` and `Result`. Each has the heading with the status, the AWB
number, a reference, the booking day and the piece count, then the origin and destination and
the history, newest first. `delivered.html` is a shipment from a hub in China held by customs,
then received, put out for delivery and delivered in India, the delivery entered at midnight.
`in-transit.html` is a shipment held by customs; its heading's status was not seen live.
`not-found.json` is the reply for a number the lookup holds no shipment under.

Numbers, references, places and clocks are invented.
