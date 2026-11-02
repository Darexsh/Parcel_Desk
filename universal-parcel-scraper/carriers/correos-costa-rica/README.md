# Correos de Costa Rica

Correos de Costa Rica parcels use enabled universal providers. There is no dedicated adapter.

Correos de Costa Rica S.A. is the national post of Costa Rica. Pymexpress is its domestic
parcel service for businesses.

## Numbers

Its items carry UPU S10 numbers ending in CR, and its tracker also follows items from abroad
under the sending post's number. Generic postal detection handles both, so no carrier rule
claims the layout: a rule would name a post that recognition cannot ask.

## Links

The tracker at correos.go.cr frames a form on sucursal.correos.go.cr, which posts the number
with a reCAPTCHA answer, so no address opens one parcel.

## Why there is no adapter

The form's server refuses a search without the CAPTCHA, and a bot manager guards the host.
The Pymexpress web service needs a business account.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
