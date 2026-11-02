# Onex

Onex parcels use enabled universal providers. There is no dedicated adapter.

Onex is a shop-and-ship forwarder delivering online purchases from its warehouses abroad to Armenia and
Georgia. Its site is onex.am.

## Numbers

Onex tracks a parcel by the number of the carrier that brought it to its warehouse, so there is no rule.

## Why there is no adapter

Its tracker sits behind a Cloudflare challenge and reads a form post carrying the page's CSRF token.

## Links

Its tracker opens numbers from its `track` parameter, but they are other carriers' numbers, so no link names
Onex.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
