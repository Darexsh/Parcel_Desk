# Correos de Bolivia

Correos de Bolivia parcels use enabled universal providers. There is no dedicated adapter.

The national post is run by the Agencia Boliviana de Correos (AGBC), which replaced the
former ECOBOL.

## Numbers

Its items carry UPU S10 numbers ending in BO: registered letters, EMS, parcels and others.
Generic postal detection handles them, so no carrier rule claims the layout. Some registered
numbers in AGBC's own published lists have a check digit that does not validate, so detection
offers no carrier for them.

## Links

The tracker form sends the number in the `codigo` parameter of its result page together with
a captcha answer, so no address opens one parcel without the captcha.

## Why there is no adapter

The tracker's page asks its own lookup for each number with the answer to a captcha, and the
lookup refuses a number sent without one: it answers HTTP 422 and a new captcha. So Correos de
Bolivia stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
