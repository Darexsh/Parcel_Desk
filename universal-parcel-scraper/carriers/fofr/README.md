# FOFR

FOFR parcels use enabled universal providers. There is no dedicated adapter.

FOFR (Systém FOFR, run by RSC Logistics) is a Czech and Slovak parcel and pallet network of
regional depots. Its site is fofrcz.cz.

## Numbers

Its shipment numbers are ten digits, a length many carriers share, Packeta among them in the
same market, so there is no rule.

## Why there is no adapter

Its tracker on objednavky.fofrcz.cz answers without a session but looks numbers up one year at a
time, and the only public numbers, from 2020, are no longer answered.

## Links

The tracker opens a shipment from its `shipment_num` parameter and looks it up at once.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
