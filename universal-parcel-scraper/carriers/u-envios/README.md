# U-ENVIOS

U-ENVIOS parcels use enabled universal providers. There is no dedicated adapter.

U-ENVIOS E.I.R.L., in Callao, is a Peruvian courier and parcel forwarder. Its UE-Box service gives
customers addresses in Miami and Shenzhen and delivers their purchases in Peru, and it also delivers
online orders within Peru. Its site is u-envios.com.

## Numbers

The tracker's placeholder shows UE, nine digits and PE, the layout of a UPU S10 number, which the
postal rules already route. No real number is known, so there is no rule.

## Why there is no adapter

The tracking page reads the number from its address and asks an open JSON service with a token
printed in the page, which answers an unknown number with HTTP 401. Its replies show the recipient's
name, ID document number, phone and address. No public number has shown a known parcel's reply yet.

## Links

Tracking links carry the number as `orden` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
