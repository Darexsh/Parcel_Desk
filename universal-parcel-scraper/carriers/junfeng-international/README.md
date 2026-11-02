# JunFeng International

JunFeng International parcels use enabled universal providers. There is no dedicated adapter.

JunFeng International (君丰国际), run by Guangzhou JunFeng Supply Chain Services since 2012 and
also branded BEESPAL, consolidates parcels in China and sends them on its own duty-paid lines to
the United Kingdom, the United States and Canada, where postal and express carriers such as
Parcelforce Worldwide, USPS and UPS deliver them. Its sites are junfengfast.com and jfchinese.com.

## Numbers

Its tracker takes the international waybill number. The example its page prints is a UPU S10
number of its UK postal partner, which the tracker answers with the flight from China and
Parcelforce Worldwide's delivery. Royal Mail's rule reads such numbers, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service without a session, which answers with the China leg and
the last-mile scans, timed without an offset. One public number is known. An adapter can follow.

## Links

Tracking links carry the number as `no` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
