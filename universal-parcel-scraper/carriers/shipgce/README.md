# Feiyang GCEx

Feiyang GCEx parcels use enabled universal providers. There is no dedicated adapter.

Feiyang GCEx (飛洋轉運), run by Global Courier Express, Inc. in San Francisco, ships parcels and online shopping door to door
from the United States to mainland China, Hong Kong and Taiwan. Its site is shipgce.com.

## Numbers

No public page shows one of its numbers, so there is no rule.

## Why there is no adapter

Its tracker on ebuy.shipgce.com is an ASP.NET WebForms page without a login or CAPTCHA: a lookup posts the
page's view state back to `listSubOrder.aspx` with the number in `txt_Search`. No public number is known to see a
found reply.

## Links

Its tracker looks numbers up by posting its form back, so no address names one.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
