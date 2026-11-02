# Fixtures

`delivered.html` and `in-transit.html` follow SmartTrack's `tracking.php` page for one parcel:
the summary box, the search field holding the number asked, the shipment's boxes and the
history table, whose day headings each precede that day's scans, newest first.

`delivered.html` goes from the parcel's data to the delivery with a parcel image named after
the number and a delivering carrier's number in the Tracking Number box. One arrival is
repeated, the out-for-delivery scan's description carries a phone and the delivery's names who
signed. `in-transit.html` has reached the destination hub; its Tracking Number box holds the
parcel's own number, its newest scan has a label and a description no rule reads, and its first
scan has no place. `not-found.html` is the page for a number SmartTrack does not know.

Numbers, names, phones, places and clocks are invented.
