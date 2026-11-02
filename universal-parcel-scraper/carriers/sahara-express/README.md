# Sahara Express

Sahara Express parcels use enabled universal providers. There is no dedicated adapter.

Sahara Express is a domestic courier and cargo company in India, founded in Chennai.

## Numbers

The tracker takes waybill numbers. A lookup archived from the delivery confirmation report
carries a number made of an S and eight digits. That layout also appears in another carrier's
corpus and rests on one sample, so no rule claims it.

## Links

The home page form sends the number as `taTrackNumber` to `showDetails1.php` by GET, so that
address opens one parcel. Lookups archived from the delivery confirmation report carry it as
`txtship_no` on `confirm_rpt.php`. The number is read from both.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
