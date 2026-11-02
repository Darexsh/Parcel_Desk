# J&T Express Brazil

J&T Express Brazil parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

J&T Express Brazil runs its own network, site and tracker, apart from the Southeast Asian J&T
operations in `j-and-t`. Its waybills in archived lookups and complaints are fifteen digits
starting with 888. Detection does not offer them, since fifteen digits are shared with other
carriers' rules.

## Links

Archived lookups on `www.jtexpress.com.br/trajectoryQuery` and the mobile page
`/mobile/expressTracking` carry the waybill in `waybillNo`. The current pages search only what
their tracking form submits, so such an address opens an empty tracker.

## Limitations

Both pages show a Tencent slider captcha before they look a waybill up, and J&T Brazil's lookup
refuses a missing or wrong captcha answer. The pages' other search needs the recipient's CPF or
CNPJ. The J&T Brasil app embeds the same captcha, so J&T Express Brazil stays on universal
providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
