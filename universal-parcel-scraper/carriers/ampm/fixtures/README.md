# Fixtures

Cut-down pages of Grupo ampm's tracker at `/rastreador/?tracking-id={number}`: the search form,
then a heading naming the number and, for a shipment, its promised delivery day, the sender and
the masked recipient, the progress rail, the table of its movements, oldest first, and its
service and guía.

- `in-transit.html`: a standard guía collected and processed at a hub.
- `returned.html`: a run that ended with the parcel returned, with the delivery details the page
  then adds.
- `delivered.html`: a run that ended in a delivery, with a row the page lists twice. The
  delivered wording was not seen on the tracker.
- `destroyed.html`: a Cainiao parcel held for delivery details, sent back under the client's
  agreement, scheduled for an international return and destroyed.
- `not-found.html`: the heading for a number the tracker has no information for.

Numbers, guías, names, places, dates and the proof-of-delivery token are invented.
