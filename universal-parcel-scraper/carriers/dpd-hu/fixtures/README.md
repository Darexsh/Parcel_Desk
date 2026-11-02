# DPD Hungary fixtures

Every identifier, reference and timestamp is invented; `16400000000001` is a 14-digit number
that was never issued. Each file is a guest-API `parcels/details` reply for the Hungarian
business unit without a postcode, in the shape of a live reply: one `parcelHistory` entry per
milestone with DPD's offset, no places, and an empty `receiver` block.

- `delivered.json`: a parcel collected from a pickup point in winter, with `+01:00` offsets and
  the `shipmentOriginalCode` the projection drops.
- `out-for-delivery.json`: a parcel out for delivery on its delivery day.
- `rerouted.json`: a parcel handed to DPD again after waiting at a pickup point, with the
  milestones out of chronological order, as DPD lists them.
