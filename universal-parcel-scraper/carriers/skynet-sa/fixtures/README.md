# Fixtures

`shell.html` is the tracking page's HTML before the circuit renders it: an empty body with the
markers of the two server components to start and the state they carry. `delivered.html`,
`in-transit.html`, `not-found.html` and `reference.html` follow the page the tracker renders
into it, as the adapter writes it out: the search box, the answer line and each waybill with
its references and its scans, newest first. The tests turn each into render batches and serve
them over a fake hub.

`delivered.html` files the proof of delivery, its scanned image under the tracker's own branch
and an email record after the delivery, repeats one scan and has a failed attempt before the
delivery. `in-transit.html` is a parcel flown in, from its landing through customs to its
dispatch from the airport. `not-found.html` is the line for a number the tracker does not
know. `reference.html` lists two other waybills whose references hold the number asked.

Numbers, references, names, branches, days and clocks are invented.
