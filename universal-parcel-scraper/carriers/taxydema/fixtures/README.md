# Fixtures

The replies follow Taxydema's `/api/track-request/{number}`: the waybill as `tt_code`, the
towns, the incoming and outgoing waybills, the progress rail and the scans, newest first, each
a line of text ending in the station.

`delivered.json` goes from the collecting hub to the delivery across the end of summer time:
one departure is repeated, three messages to the recipient carry a masked phone, a sender and
links, and the delivery names who took the parcel. `in-transit.json` has reached its delivery
station, after a second hub received it, and its newest row is a message to the recipient; the
rail steps it has not reached are empty. `not-found.json` is the HTTP 404 reply for a number
Taxydema does not know, and `forbidden.json` the HTTP 403 reply to a client name the site
refuses.

Numbers, names, phones, links, places and clocks are invented.
