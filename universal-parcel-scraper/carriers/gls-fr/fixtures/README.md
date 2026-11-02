`delivered.json`: a delivered parcel with two scans (`CON`, then `LIV`), a
planned delivery date and a sender label. Constructed in the consignee endpoint
shape with synthetic numbers; every recipient, address, contact, signature and
instruction field is a placeholder the privacy test looks for in the result.

`pickup-point.json`: the record the tracking page reads for the shop holding a
parcel, in the `searchNode` endpoint shape, with an invented shop, address and
id.

`depot.json`: the record the tracking page reads for the depot holding a parcel,
in the `agency` endpoint shape, with an invented depot, address, phone and code.
