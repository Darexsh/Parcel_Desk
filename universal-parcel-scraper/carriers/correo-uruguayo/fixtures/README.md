# Fixtures

All follow the shape of the tracker's `GET /seguimientoEnvios/eventosweb` reply: an array with one
entry, holding the item's codes, its state, the step of the page's progress bar and its scans
newest first, each with a wall clock, wording, office, office code, scan code, source and, for
some, a sub-code, operator, round or delivery note.

- `delivered.json`: a domestic item delivered by a postman, with the delivery reported twice in
  the same minute and recipient details after the delivery wording.
- `in-transit.json`: a domestic item between offices.
- `inbound.json`: mail from abroad under its origin code, with the code the post gave it, the
  sending post's scans and a customs hold.
- `not-found.json`: the entry for a domestic code the tracker does not know, which names it.
- `not-found-inbound.json`: the entry for another post's code the tracker does not know, which
  names no code.
- `invalid-product.json`: the entry for a code ending UY with service letters the post does not
  use.
- `filed.json`: the entry for an item whose records went to the archive.

Codes, recipient details, offices, towns, office codes, operators, rounds, clocks and the
contact number are invented.
