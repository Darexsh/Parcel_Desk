# Correios de Angola

Correios de Angola parcels use enabled universal providers. There is no dedicated adapter.

Correios de Angola (Empresa Nacional de Correios e Telégrafos de Angola, E.P.) is Angola's
national post, carrying letters, parcels and EMS items within Angola and abroad. Its site is
correiosdeangola.ao.

## Numbers

Correios de Angola gives registered items, parcels and EMS items UPU S10 numbers ending `AO`.
Generic postal detection handles these numbers, so no rule for Correios de Angola claims them.

## Why there is no adapter

Its tracker is an ASP.NET form that posts the number back to itself without a login or CAPTCHA
and says when it finds no item. No public number has shown a known item's reply yet.

## Links

The tracker posts its form and has no address for one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
