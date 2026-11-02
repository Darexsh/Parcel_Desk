# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracker's
`/ope/rest/tracking/{number}`, with the summary, progress, parcel, pickup and estimate fields it
carries. `delivered.json` is a shipment of two parcels whose scans repeat a second or two apart;
the second parcel reaches the destination branch later, a delivery fails and the scans cross
the change to summer time. Its scans name drivers and carry notes with a neighbour's name and a
phone number. `in-transit.json` is one parcel whose arrival repeats within a minute, whose van
broke down on its first round, with a forecast scan, out for delivery again and a driver's
position. `not-found.json` is the HTTP 404 body for a number Liccardi does not know.

Numbers, names, branches, places, references and clocks are invented.
