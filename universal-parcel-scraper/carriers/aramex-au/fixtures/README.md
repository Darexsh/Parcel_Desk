# Fixtures

Each file follows the shape of the reply `GET /umbraco/api/TrackingApi/GetTrackingData` gives for
one number: the depots that collect and deliver the parcel, its label and its scans oldest first.
Numbers, depots, parties, references and clocks are invented.

- `delivered.json`: a delivered parcel, with the label's hidden record, a scan before pickup, an
  internal scan, a depot of the regional linehaul partner and the signatory's details.
- `in-transit.json`: a parcel on its way with a delivery estimate, a priority service, a label
  notice after pickup and a collection point's details.
- `pre-pickup.json`: a labelled parcel the courier has not collected, without its pickup depot
  or service.
- `sscc-alias.json`: a parcel asked by the sender's SSCC, with Aramex's own label beside it.
- `not-found.json`: the answer to a number without scans.
