# Fixtures

`spring-delivered.html` and `royal-mail-in-transit.html` follow the fragment the tracking page's
`ShipmentData` action returns: one card whose click handler carries the scans and the
shipment's details as entity-encoded JSON, then the rendered details with the air waybill,
destination postcode and partner number. One parcel is handed to Spring's PostNL service and
delivered in France, with a repeated scan; the other is handed to Royal Mail from a Pacific
processing center, with partner places that hold postcodes, a dash and a country named twice.
`not-found.html` is the card of an unknown number.

Numbers, references, places, postcodes and clocks are invented.
