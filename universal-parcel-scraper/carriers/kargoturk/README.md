# KargoTurk

KargoTurk parcels use enabled universal providers. There is no dedicated adapter.

KargoTurk Teslimat Hizmetleri Ltd. Şti., based in Kağıthane, Istanbul, delivers parcels for online
shops and businesses across Turkey, with four-hour same-day delivery in Istanbul, next-day and
cash-on-delivery services, returns and motorbike couriers. Its site is kargoturk.com.tr.

## Numbers

Its tracking code is the sending shop's barcode, twelve or thirteen digits whose leading digits
differ from shop to shop. Other networks print the same lengths, so there is no rule.

## Why there is no adapter

The tracker is an open page that answers the number alone, without a login or CAPTCHA, and it
answers public numbers with their scans. Its replies also carry masked recipient details and courier
names that an adapter must leave out. An adapter can follow.

## Links

Tracking links carry the number as `har_kod` on the `tracking` page at online.kargoturk.com.tr.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
