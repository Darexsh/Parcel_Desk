# Daiichi Freight System

Daiichi Freight System parcels use enabled universal providers. There is no dedicated adapter.

Daiichi Freight System, Inc. (第一貨物株式会社), founded in 1941 and based in Yamagata, runs a
less-than-truckload network across Japan, with forwarding, warehousing and contract logistics. Its
site is daiichi-kamotsu.co.jp.

## Numbers

Its inquiry numbers are eleven digits whose last digit is the remainder of the first ten divided by
seven. [Japan Post](../japan-post/README.md)'s numbers share that layout, so no rule claims it.

## Why there is no adapter

The tracker is a plain page that reads up to ten numbers from its address, without a login or
CAPTCHA, and tells an unknown number from one whose check digit is wrong. No public number it still
knows has been found. An adapter can follow.

## Links

Its site policy asks anyone linking to the site to contact the company first, so links open the
tracking page only.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
