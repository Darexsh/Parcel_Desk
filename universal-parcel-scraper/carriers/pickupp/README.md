# Pickupp

Pickupp parcels use enabled universal providers. There is no dedicated adapter.

Pickupp is a Hong Kong delivery platform with door-to-door, four-hour, next-day and self
pick-up services. Its Singapore network is `pickupp-sg`, with its own site, tracker and number
suffix.

## Numbers

A Pickupp order number is PU, twelve digits and the region code, HK in Hong Kong. Pickupp's API
documentation shows it. `pickupp-1` claims PU, twelve digits and HK; no other carrier uses that
layout.

## Links

`hk.pickupp.io/en/tracking?orderNumber={number}` opens one order, and so does the merchant
portal's tracking page, which the API returns as each order's tracking link. The `zh` pages are
the Chinese versions.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
