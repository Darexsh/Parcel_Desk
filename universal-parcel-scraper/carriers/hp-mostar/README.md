# Hrvatska pošta Mostar

Hrvatska pošta Mostar parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

The tracker follows express, registered, insured and parcel items, domestic and international,
by their UPU S10 numbers, and its example is a registered letter posted in Bosnia and
Herzegovina. BH Pošta, the other postal operator in the Federation, also issues S10 numbers
ending in `BA`, so the suffix does not name the operator. Generic postal detection handles
S10 numbers, so no Hrvatska pošta Mostar rule claims them.

## Links

The tracking form submits the number as `tntnumber` on the same page, so
`post.ba/servisi/pracenje-posiljke?tntnumber={number}` opens one item; the English page
`post.ba/services/track-and-trace` takes the same parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
