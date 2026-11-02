# Fixtures

`not-found.html` is the fragment `atlanticcourier.net/action` returns for a number without a
shipment: a table with the tracker's notice and no number. `delivered.html` and `in-transit.html`
follow the fragment it returns for a shipment: the summary headed by the air waybill, the progress
rail, the consignee's name and the destination, the delivery's day and time with who signed and
the partner's forwarding number, and the scans newest first. `delivered.html` is a shipment from
India delivered in New Zealand by a partner, with a repeated receipt and a row without a place;
`in-transit.html` one received in Pune and held by customs in Delhi on its way to Sweden. Air
waybills, forwarding numbers, names, places, wordings and clocks are invented.
