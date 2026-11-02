# LM Parcel

LM Parcel parcels use enabled universal providers. There is no dedicated adapter.

LM Parcel (六脉速运, 六脉小包) runs direct parcel lines from China for online sellers to the
United States, where USPS delivers, the United Kingdom, Germany, where DHL delivers, and the
Netherlands. Its site is lmparcel.com.

## Numbers

LM Parcel numbers are LM and ten digits. An archived lookup on its tracker, which still answers
the number, and an example label in its API document have them. They are two sources, so the
rule is low.

## Why there is no adapter

The tracker asks an open JSON service without a session or CAPTCHA, which answered a public
number with its scans and gives an empty list for an unknown one. Each scan states its own UTC
offset, and one marks the hand-off to the last-mile carrier. An adapter can follow.

## Links

Tracking links carry the number as `nums` on lmparcel.com's search page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
