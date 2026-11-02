# Fixtures

Each file follows the shape of the reply `GET /umbraco/api/TrackingApi/GetTrackingData` gives on
aramex.co.nz for one number: the depots that collect and deliver the parcel, its label and its
scans oldest first. Numbers, depots, parties, references and clocks are invented.

- `delivered.json`: a delivered parcel across the end of daylight saving, with a courier's run
  named after its zone and the signatory's details.
- `in-transit.json`: a parcel on its way with a delivery estimate, a failed collection before
  pickup and a depot named after two towns.
- `customs.json`: a parcel from abroad through customs, without a pickup depot.
- `pre-pickup.json`: a labelled parcel the courier has not collected.
- `onforwarded.json`: a parcel handed on to NZ Post for a rural delivery, with NZ Post's label.
- `not-found.json`: the answer to a number without scans.
