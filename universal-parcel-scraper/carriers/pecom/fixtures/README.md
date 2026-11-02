# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the `LK.OCR.Get` call on
`POST https://pecom.ru/ajax/`, cut down to one timetable and one storage day per cargo.
`delivered.json` is a cargo collected at a pickup point: its statuses go from acceptance to
collection, a possible return has no date, and two transit rows send the cargo to the
receiving terminal and repeat its arrival there. `in-transit.json` is a cargo on its way to a
terminal, with a planned and a corrected arrival date and a transit row at a pickup point on
the way. Both carry a sender and a recipient, which the adapter must not read.
`not-found.json` is the JSON-RPC error PEC sends with HTTP 401 for a cargo code it does not
know.

Numbers, names, phones, places, departments, coordinates and clocks are invented.
