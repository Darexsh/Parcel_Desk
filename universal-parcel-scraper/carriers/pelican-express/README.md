# Taiwan Pelican Express

Taiwan Pelican Express parcels use enabled universal providers. There is no dedicated adapter.

Taiwan Pelican Express (台灣宅配通) is a Taiwanese door-to-door parcel carrier.

## Numbers

The tracking number is the first twelve digits on the waybill (前12碼). The tracker shows it
with a `-001` piece suffix, and one archived lookup passes those fifteen digits as the number.
On every sample the twelfth digit is the remainder of the first eleven divided by seven.
Yamato, Sagawa and Japan Post twelve-digit numbers carry the same check, so no rule claims
these numbers.

## Links

`query2.e-can.com.tw/self_link/id_link.asp?txtMainID={number}` opens one parcel. Older lookups
use `id_link_c.asp` with `txtMainid`; the parameter name and path are case-insensitive.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
