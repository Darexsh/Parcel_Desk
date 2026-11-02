# Fixtures

Synthetic getExternalTrace replies with an invented waybill, facilities, clocks, couriers,
phones and signers. They keep the trace's envelope and field names, including the private
fields the parser drops, without any captured parcel details. `not-found.json` is the reply
for an unknown or expired waybill and `verify-fail.json` the one for a refused signature.
