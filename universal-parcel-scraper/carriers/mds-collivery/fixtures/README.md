# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracking page's
`ajax/waybill/tracking/{waybill}` lookup for one waybill: the current status over the progress
rail, the waybill, the collection and delivery addresses, the history oldest first with Unix
times, a status sentence and the WhatsApp support links. `delivered.json` is a completed and
invoiced booking with a failed attempt, a booking change and a second delivery round, whose
history has no delivery line, as the page shows one. `in-transit.json` is a parcel whose
driver has left with it, a step the history leaves out. `not-found.json` is the HTTP 404 body
for a waybill Collivery has no record of.

Waybills, names, addresses, branches, clocks and the support number are invented.
