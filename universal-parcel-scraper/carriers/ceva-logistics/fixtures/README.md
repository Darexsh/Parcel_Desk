# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the public lookup's
`/shipments/{house bill}/HB`, with the summary, the events grouped by terminal, the exception
log and the shipment details the page reads. `delivered.json` goes from the booking to the
delivery through a hub named by code alone: one hub scan is repeated, the customer could not be
reached, a delivery window is offered and confirmed, and a final-mile check-out comes after the
delivery. The window's confirmation carries a UTC clock that lists it above both. The events
carry signers and remarks, and the details an order number and a bill of lading.
`in-transit.json` waits at the destination terminal after crossing a border under bond. The
offer of a delivery window and its confirmation carry the same instant, the offer on the
terminal's wall clock and the confirmation in UTC.

`search.json` is the tracking page's search for an order number: it matches the in-transit
shipment through that number and another shipment through a longer reference that begins with
it. `search-empty.json` is the search's answer when nothing matches, and `not-found.json` the
lookup's answer for a house bill it does not know.

Numbers, names, references, places and clocks are invented.
