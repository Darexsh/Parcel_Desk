# Fixtures

The pages follow the tracking page `straightship.com/track-your-shipment/tracking-id/{number}/`
renders, cut down to its title, the summary table, the history, oldest first, and the note that
the clocks are UTC. `delivered.html` is a parcel delivered after its delivery round, with the
form that asks for the recipient's name before it shows the delivery photos. `in-transit.html`
is a parcel at a transit station, still summarized as ready for shipping. `attempted.html` has
two delivery rounds that did not deliver and a row loaded twice. `returned.html` is a parcel on
its way back to the shipper. `not-found.html` is the notice for a number the tracker does not
hold.

Numbers, places and clocks are invented.
