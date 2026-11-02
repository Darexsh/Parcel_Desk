# Ward Transport & Logistics

Ward freight shipments use enabled universal providers. There is no dedicated adapter.

## Numbers

Ward PRO numbers are a three-digit terminal and seven digits, printed with a dash. Its tracker
also takes them as eleven digits without the dash, as an archived lookup shows. Both shapes
are shared with other carriers, so no rule claims them. The tracer also searches by bill of
lading with the origin postal code, which is not a tracking number.

## Links

Ward's tracker reads a PRO number from `?pro=` on
`wardtlctools.com/wardtrucking/traceshipment/create`.

## Why there is no adapter

That address answers a plain GET with a server-rendered page, with no token, captcha or
sign-in: the shipment's status, dates and movements, or Ward's own "Pro is not in Ward system"
notice. Its host, `wardtlctools.com`, only answers connections from the mainland United States
and Canada, though. From Europe, Mexico, Brazil, Puerto Rico and Japan the connection times out
before any reply, for the whole site. Ward publishes no tracking app, so Ward stays on
universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
