# Wizmo

Wizmo parcels use enabled universal providers. There is no dedicated adapter.

Wizmo is a Canadian cross-border e-commerce consolidator. It moves parcels into and out of Canada
and the US and hands them to a final-mile carrier such as DHL eCommerce, Canada Post or UPS. Its
site is shipwizmo.com.

## Numbers

Its references are `WD` and ten digits, which `wizmo-1` suggests at low confidence; the Aramex
rules for two letters and ten digits share the shape. Its tracker also answers the final-mile
carrier's number, which stays with that carrier.

## Why there is no adapter

Its tracking page reads a JSON API without a session, and the reply names the final-mile carrier
and its number. It keeps a shipment only for a short time, and no current public reference is
known to confirm an answer. Its event times carry no zone.

## Links

The tracking page opens a reference from its path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
