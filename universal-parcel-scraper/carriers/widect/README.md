# Widect

Widect parcels use enabled universal providers. There is no dedicated adapter.

Widect is Turkish Airlines' door-to-door e-commerce delivery service, run by its subsidiary THY Hava
Kargo Taşımacılığı A.Ş. It flies online orders from Türkiye to destinations on Turkish Airlines'
network, where partners deliver them, and agencies such as [ShipEntegra](../shipentegra/README.md)
sell its service. Its site is widect.com.

## Numbers

Its tracker gives no layout or example, and also takes the number of the carrier that delivers a
parcel abroad. No public number is known, so there is no rule.

## Why there is no adapter

Every lookup needs a CAPTCHA.

## Links

The tracking page fills its form from `tracking-number` in its address, but each lookup still needs
the CAPTCHA, so there are no tracking links.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
