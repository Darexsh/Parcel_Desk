# Fixtures

Each file follows the shape of the reply `POST /api/aggregator/v1/track/trackParcel` gives for one
number: the numbers asked for and those the tracker does not know, then the parcels found with
their scans and partner sites. Numbers, ids, places, parties, opening hours and clocks are
invented.

- `auspost-delivered.json`: a parcel from UBI's hubs to an Australia Post delivery, with Australia
  Post's relayed scans, UBI's own arrival scans abroad, a place with a postcode and repeated scans
  under the parcel's two numbers.
- `aramex-linehaul.json`: a parcel for Aramex Australia, still at the origin hub, with a booked
  flight, Aramex's notice relayed under China's zone label and Aramex Australia's home page as its
  partner site.
- `canada-transit.json`: a parcel under a Canada Post number, with Canada Post's relayed notices
  under a zone abbreviation and no partner site.
- `not-found.json`: the answer to a number the tracker does not know.
- `refused.json`: the answer to a request the service cannot read.
