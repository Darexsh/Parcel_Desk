# MOVIN

MOVIN parcels use enabled universal providers. There is no dedicated adapter.

MOVIN is a business-to-business express carrier in India, a joint venture of UPS and InterGlobe Enterprises,
moving shipments by air and road between Indian cities. Its site is movin.in.

## Numbers

Its tracker asks for a tracking ID entered as a reference number. No public page shows one, so there is no rule.

## Why there is no adapter

Its tracking page embeds its tracker on Shipsy, whose lookup API refuses a request without a Cloudflare
Turnstile token.

## Links

The Shipsy tracker opens numbers from its `refNum` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
