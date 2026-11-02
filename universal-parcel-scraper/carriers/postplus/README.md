# PostPlus

PostPlus parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

PostPlus (Post+ B.V.) is a postal consolidator with its hub near Amsterdam Schiphol. It sorts
cross-border small packets and parcels and hands them to postal operators and other delivery
companies. Its tracking form's example is a UPU S10 number issued by Lithuania Post. Postal
detection names the issuing post for S10 numbers, so no rule claims them.

## Links

The home page reads a number from its `tracking` parameter and submits its tracking form with
it, so `post.plus/?tracking={number}` opens one parcel.

## Why there is no adapter

The tracking form posts `parcel` to `wp-content/themes/postplus/parcel-request.php` with a
reCAPTCHA v3 token. Without a token, an unknown number gets "We were unable to find a shipment
with this reference or barcode."; whether a known one needs the token is unverified, as no
public page shows a number PostPlus tracks.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
