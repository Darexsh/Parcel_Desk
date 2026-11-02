# Fixtures

Each fixture follows GlobalPost's tracking page for one number, `/track-detail/?t={number}`,
without its styles, scripts, header and footer: the hidden notice for an unknown number, the
search form, then one card with the progress rail, the origin and destination, GlobalPost's
number, the final-mile partner and its number, the service and the scans, newest first under
one header per day.

- `delivered.html` is a parcel delivered by Royal Mail. One facility scan is listed twice, one
  comes twelve minutes past midnight, one is at a place the tracker shows as "Not Available",
  one at the shipper's ZIP code and one without a place.
- `in-transit.html` is a parcel on its way with Canada Post after customs, with scans relayed
  from USPS and Canada Post, a facility whose place ends in a cut-off ZIP code and a place with
  trailing spaces.

- `returned.html` is a parcel Canada Post failed to deliver and sent back: customs and USPS scans
  on the way home, then "Delivered" at the sender's town, under a heading that names the
  recipient's.

An unknown number gets a redirect to the search page with a notice, so it has no fixture.

Numbers, partners' numbers, towns, facilities, ZIP codes and clocks are invented.
