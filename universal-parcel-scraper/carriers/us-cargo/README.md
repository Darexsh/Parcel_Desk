# US Cargo

US Cargo parcels use enabled universal providers. There is no dedicated adapter.

United States Cargo and Courier Services, founded in Columbus, Ohio, in 1972 and owned by Pitt Ohio
since 2011, delivers parcels and freight in Ohio and around Pittsburgh from its own terminals. It
keeps its own tracker and numbers, apart from Pitt Ohio's. Its site is us-cargo.com.

## Numbers

Its tracker takes a PRO or order number or a bill of lading. No public page shows one or states
their layout, so there is no rule.

## Why there is no adapter

The tracker reads the number from its address and draws its answer on the server without a login or
CAPTCHA. No public number has shown a known shipment's reply yet.

## Links

Tracking links carry the number as `prodnumber` on the tracking page, with `checksrch=prodnumber`.
Bill of lading lookups carry `loadnumber` instead and are not read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
