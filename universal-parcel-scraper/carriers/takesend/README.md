# Take Send

Take Send parcels use enabled universal providers. There is no dedicated adapter.

Take Send is 泰嘉物流 (Shenzhen Taijia Logistics), a Shenzhen consolidator founded in 2009 whose
site is takesend.com. Most of its lines hand parcels to a post or express carrier under that
carrier's number; its own numbers appear on its lines to South Africa and the Gulf.

## Numbers

Take Send's weekly delivery-time posts print its numbers with most digits hidden: `TS` and
thirteen digits, which begin with the date the parcel was registered. No public page shows a
whole number, so `takesend-1` only suggests Take Send and the corpus holds a made-up number in
that layout.

## Tracker

The tracker at `k5.takesend.com:8180` runs on the Kingtrans K5 forwarder platform over plain
HTTP. It needs no account, cookie or CAPTCHA and answers in XML, with the partner's number when
a partner delivers the parcel. No found reply has been seen, so there is no adapter yet.

## Links

The tracker's `WebTrack?action=list&bills=` opens one number.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
