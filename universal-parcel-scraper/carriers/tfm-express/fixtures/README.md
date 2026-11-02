# Fixtures

The pages follow the answer of `POST customer.tfmex.com/Skybill/TrackSkybill` with offset 0,
trimmed of most of its style sheet: the tracking form, then the shipment's summary and its
history newest first. `delivered.html` is a parcel delivered in the UAE on its second round, after
a round that found nobody in; one hub row is repeated whole. `in-transit.html` is a parcel
received at the hub. `not-found.html` is the notice for an airwaybill the tracker does not know.

Airwaybills, the form's key and token, and clocks are invented.
