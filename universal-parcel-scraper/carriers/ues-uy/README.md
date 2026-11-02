# UES

UES parcels use enabled universal providers. There is no dedicated adapter.

UES is a Uruguayan courier for e-commerce parcels, cards and mail, with home delivery and a
network of Pick Up and Xpres collection points.

## Numbers

UES's help pages say its tracking numbers start with UES or UESM. Customers quote both: UESM
followed by nine digits, and UES followed by thirteen digits. Rule `ues-uy-1` claims these two
layouts with high confidence, since the prefix is the carrier's own name and no other carrier
uses it.

## Links

The tracker page reads the number from its `criterioId` parameter, fills the field and runs
the lookup. That first lookup carries no reCAPTCHA answer and is refused, so the visitor solves
the checkbox and searches again before the history appears. The page's `cr` parameter only
fills the field.

## Why there is no adapter

The tracker sends the number and the reCAPTCHA v2 checkbox answer to `ws_paquetes.php` as
`criterioId` and `captcha`. The service checks the answer before it looks the number up:
without one, or with an empty or wrong one, it replies "No se pudo verificar el Captcha" for any
number. The home page's tracking form posts to `ws_paquetes_index.php` with the same check.

The UES Go app linked from the site (`com.soydelivery.xpres`) orders same-day courier jobs and
lists only the signed-in customer's own orders, and the customer portals need an account. The
library solves no captcha, so UES stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
