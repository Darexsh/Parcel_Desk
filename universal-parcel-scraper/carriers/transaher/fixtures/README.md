# Fixtures

`shell.html` is the tracking page's HTML before the circuit renders it: an empty body with the
marker of the one server component to start. `delivered.html`, `in-transit.html` and
`not-found.html` follow the page the tracker renders into it, as the adapter writes it out: the
progress rail, the summary and the history grid, oldest situation first. The tests turn each into
render batches and serve them over a fake hub.

`delivered.html` files a situation before the registration it follows, repeats one situation,
lists the delivery van after the delivery and carries a recipient, a reference, a shipping day
and the proof-of-delivery button. `in-transit.html` heads the page with the status the summary
keeps while the history has moved on. `not-found.html` is the sentence for a number the tracker
does not know.

Numbers, expedition numbers, names, references, days and clocks are invented.
