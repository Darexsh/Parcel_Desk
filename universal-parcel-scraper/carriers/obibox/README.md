# Obibox

Obibox parcels use enabled universal providers. There is no dedicated adapter yet.

Obibox delivers e-commerce parcels in Quebec and Ontario. It began as Xpedigo, whose tracker
links still lead to Obibox's.

## Numbers

Numbers start with `XP`, a three- or four-letter shipper code and the shipper's order
reference, and end with the package's index after `_` (until early 2025) or `Q`. Archived
lookups on its tracker show the layout across eight shipper codes and no other carrier prints
it, so `obibox-1` names Obibox with high confidence.

## Tracker

The tracker reads an open JSON interface without a login or CAPTCHA. It keeps about six months
of parcels, and its replies carry the recipient's name, address and position.

## Links

The trackers keep the number as the whole path.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
