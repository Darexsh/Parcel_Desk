# Airwings India

Airwings India parcels use enabled universal providers. There is no dedicated adapter.

Airwings India (Airwings Logistics Pvt. Ltd., formerly Airwings Courier Express (India) Pvt. Ltd.) is a Mumbai
international courier and cargo company of the Dubai-based Jashanmal group, with an office in Cochin. It sends
export and online shops' parcels worldwide and hands them to other carriers for the last leg. Its site is
airwingsindia.com.

## Numbers

Its tracker takes an air waybill or a reference number as free text, and its site gives no layout. No public
page shows an Airwings India number, so there is no rule. The last-mile carrier's number on a forwarded parcel
belongs to that carrier.

## Why there is no adapter

Its tracking page posts the number to an open JSON API of Xpresion, a courier management system:
`POST xpresion.airwingsindia.com/api/v1/Tracking/Tracking`, with the number in `AWBNo`, `Type` `A` for an air
waybill or `R` for a reference, and a fixed login the page gives every visitor; there is no CAPTCHA or session.
A found reply lists the scans and names the forwarding carrier's number and tracking link, so an adapter could
hand the parcel on. It also names the shipper, consignee and receiver and links a proof-of-delivery image, which
an adapter must leave out. An unknown number gets HTTP 200 with response code `TD01`, "AWB does not exist". No
public number is known to see a found reply.

## Links

The tracking page reads the number from its `awbno` parameter and looks it up on load.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
