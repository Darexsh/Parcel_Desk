# TIG Freight

TIG Freight parcels use enabled universal providers. There is no dedicated adapter.

TIG Freight Management is a Melbourne freight manager that books shipments with partner carriers
for its clients through its own platform, Open360. Its site is tigfreight.com.

## Numbers

Its tracker also shows shipments under the consignment numbers of the carriers that move them, and
no public page shows a number of TIG's own, so there is no rule.

## Why there is no adapter

The tracking page asks an open GraphQL endpoint, `POST api.open360.com/tracking/graphql`, for the
shipment by its reference, without a session or CAPTCHA. An unknown reference gets the error
`Shipment not found`. No current public number is known to see a found reply.

## Links

The tracking page opens the number from its path. A number that another carrier's rule names
with high confidence stays that carrier's.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
