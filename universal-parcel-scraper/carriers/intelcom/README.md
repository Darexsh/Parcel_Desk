# Intelcom / Dragonfly

Tracks Canadian Intelcom and Dragonfly shipments through the Canadian Dragonfly portal's anonymous tracking service. Dragonfly Australia and Netherlands use separate services.

## How it works

1. `direct`: GET the public Canadian tracking endpoint. A successful reply must identify the requested shipment; only the service's explicit `not_found` reply establishes absence.

Observed Canadian status codes establish milestones even when the English label is a marketing phrase. Other wording uses shared classification, with that provenance retained. Offset-bearing scan times and epoch milliseconds keep their instants. A dated current status without history is returned as a summary.

A return collected from the customer has its own codes. The service flags a collected return as delivered, which the adapter does not take as a delivery.

The delivery estimate is the one the tracking page shows: a time window once a driver has the parcel, otherwise a day, taken in the timezone of the service's own estimate. There is none for pickups, problems, deliveries or a window that has passed. The sender is the client the tracking page names, and it names only some clients. A return collected from the customer names none, since the client is its recipient; its `sender_name` is null, so a name an earlier check gave is dropped.

## Limitations

Merchant references can identify Intelcom shipments without an Intelcom prefix. `INTLCM` numbers, including the lettered series such as `INTLCMD` and `INTLCMJ`, are
Intelcom identifiers; the adapter sends the complete value. Detection suggests Intelcom for the `CRIN` family; shipper and merchant references need an explicit carrier or an Intelcom tracking link. Recipient addresses, driver names and proof images are discarded. Local scan clocks stay unresolved because Canada spans several timezones.

## Testing

`INTELCOM_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/intelcom`
