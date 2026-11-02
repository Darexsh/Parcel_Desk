# Fixtures

The files follow the shape of the tracker's `GET /trackingNumber/?trackingNumber={code}&lng=en`
reply: `error`, a `message`, and in `data` the item's scans oldest first, an empty
`estimatedDelivery`, whether the item is EMS and whether it was delivered. Each scan has the
clock the page shows, the same clock in ISO form, the IPS country name, the office, the event
with its leg, a mail category, the next office and an `extraInformation` text. The reply does
not name the item code.

`inbound-delivered.json` is mail from the Netherlands delivered in Armenia after a missed
delivery, with a repeated row. `outbound-delivered.json` is a HayPost item delivered in France.
`in-transit.json` is mail from China held at customs in Armenia. `not-found.json` is the reply
for a code the tracker does not know.

Item codes, offices and dates are invented.
