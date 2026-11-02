# DHL eCommerce Iberia

DHL's parcel network in Spain and Portugal, formerly DHL Parcel Iberia, through
the gateway behind its customer tracking page. German DHL Paket is
[dhl](../dhl/README.md) and the Benelux network is
[dhl-ecommerce-nl](../dhl-ecommerce-nl/README.md).

## How it works

1. `direct`: `GET clientesparcel.dhl.es/LiveTracking.GTW/api/shipment-detail?number=…`,
   the request the tracking page makes for a shipment opened without a
   postcode. It returns one shipment with a newest-first scan feed. An unknown
   number is an empty 204, which is the only answer read as a missing parcel.

## Notes

- CTT Express delivers consumer parcels in Spain and DHL eCommerce volumes in
  Portugal. This portal only knows shipments that entered through DHL and
  keeps the fuller history for them, including the scans before the handover.
  [ctt-express](../ctt-express/README.md) reads the others.
- The number is sent without a postcode: a wrong one strips the shipment
  header. An empty number is never sent, because the gateway answers it with
  an unrelated shipment.
- The gateway echoes the number it looked up. The answer is bound to that echo
  and to nothing else, so a licence plate or a CTT Express code is only
  accepted when it was the number asked for.
- Its firewall rejects a request with an HTML page under HTTP 200. That page
  is a challenge and never a missing parcel.
- Scans carry a short code, kept in [statuses.json](statuses.json) with the
  stage each one means. English wording is requested and returned as sent.
  Depot scans end in a preposition and are completed with the scan's town, as
  the page does. One sent without its code is recognized by that wording, and
  so is the delivering depot's receipt, sent without a code.
- A code missing from the list has no stage. The current stage then comes
  from the shipment's own status number.
- A delivery stays the current stage when a notice follows it, but not when a
  later delivery round or failed attempt shows it came early.
- The weight is shown in kilos.
- The `ServicePoint` block is the DHL ServicePoint shop, as the page's
  ServicePoint card shows it; the anonymous answer has no recipient address.
  While the parcel waits there, the pickup point is the shop's name, then its
  street, then postcode and town (the name alone without a street or town). It
  stays once the recipient collects the parcel there: a pickup scan (`RS`) on a
  shipment marked `DeliveredInServicePoint`. A door delivery never gets one.
- When CTT Express delivers the parcel, its label code is passed on as the
  delivery partner's number.
- Ten-digit numbers overlap with DHL Express and other carriers, so detection
  only suggests this carrier and the portal's answer attributes the parcel.
  Twelve and twenty-two digits, `JJD` plates and S10 numbers are accepted when
  the carrier is named and claimed by no rule here.
- The tracking page's shipment links are `ModificarEnvio` in Spanish,
  `ModificarMeuEnvio` in Portuguese and `ModifyMyShipment` in English. A pasted
  one gives its number and this carrier, and leaves out the postcode a link can
  carry after the number.

## Limitations

- Scans are local wall clocks without an offset, in a network that spans the
  Spanish mainland, the Canary Islands and Portugal. They are returned as
  local times and never as instants, so there is no delivery instant either.
- The place of a scan is a province or depot label. The registration scan is
  filed under head office and has no place.
- An empty answer also covers purged shipments; how long history is kept is
  not known.
- The ServicePoint's code, coordinates and opening hours, the sender's
  reference and the delivery day are dropped.

## Testing

`npm run test:carriers:live -- carriers/dhl-ecommerce-es` checks that a
synthetic number gets a clean not-found. Set
`DHL_ECOMMERCE_ES_TRACKING_NUMBER` outside the repository to read a real parcel.
