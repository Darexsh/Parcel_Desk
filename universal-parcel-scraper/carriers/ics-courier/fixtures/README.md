# Fixtures

The fixtures follow the shape of ICS Courier's tracking page for one number: the form, the
summary row, then the parcel's panel with its pickup point and its history.

- `delivered.html` is a delivered ground parcel whose page carries the recipient, the signatory
  and a signature image. Its history has a branch row recorded after later scans and a branch
  with a space before the comma.
- `in-transit.html` is a next-day parcel on its way, with an estimated delivery day.
- `smartspot.html` is a parcel left at a SMARTSpot after a failed attempt, with the point's
  name, address, hours and coordinates in its panel.
- `label-created.html` is a parcel the shipper has labelled but ICS does not have yet.
- `not-found.html` is the page's answer for a number the tracker does not have.

Numbers, names, addresses, postal codes, coordinates, signatures and clocks are invented.
