# Fixtures

The pages follow the tracker's answer to `GET https://fictracking.fedex.com/?MyFICNumber={number}`.

- `delivered.html` is a parcel Royal Mail delivers in Britain. One scan is listed twice so the
  tests can show it is kept once.
- `in-transit.html` is a parcel from FedEx's American hubs, presented to Korea's customs. Its
  partner's button opens PostNord's DirectLink.
- `not-found.html` is the page for a number the tracker has no record of.

The shipper's reference and the partner's local number are present so the tests can show they are
left out. Numbers, shippers, clocks and references are invented.
