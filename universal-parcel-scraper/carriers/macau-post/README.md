# Macao Post

Macao Post parcels use enabled universal providers. There is no dedicated adapter.

Macao Post (澳門郵政, Correios de Macau) is run by Macao's Post and Telecommunications Bureau
(CTT), a government bureau. Its site is ctt.gov.mo.

## Numbers

Macao Post gives registered items, parcels and EMS items UPU S10 numbers ending `MO`, as its
tracking page's examples show. Generic postal detection handles these numbers, so no rule for
Macao Post claims them.

## Why there is no adapter

The tracking page shows an image code but checks it only in the browser; its data comes from an
open JSONP service that answers without a session. No public number has shown a known item's
reply yet. An adapter can follow.

## Links

The tracking page looks numbers up in place, so no address names one item.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
