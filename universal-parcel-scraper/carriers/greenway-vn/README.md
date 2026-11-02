# Greenway

Greenway parcels use enabled universal providers. There is no dedicated adapter.

Greenway, run by Công ty TNHH Đức Thành GR in Hanoi, ships online sellers' parcels from Vietnam to
the United States, where USPS delivers them, with a customer portal and an API. Its site is
greenwayvn.com.

## Numbers

Its API documentation gives package codes as G and sixteen digits, made of the customer's id and the
package's id, and adds SB in its webhook example. The examples are made-up orders, and Colis Privé's
`colis-prive-1` reads most codes of G and sixteen digits, so there is no rule. Parcels also carry a
USPS number, which the USPS rules read.

## Why there is no adapter

The tracking page asks an open JSON service without a login or CAPTCHA, which takes several codes at
once and answers an unknown one as not found. [The Human Express](../the-human-express/README.md)
runs on the same platform. No public code has shown a known parcel's reply yet. An adapter can
follow.

## Links

Tracking links carry the code as `code` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
