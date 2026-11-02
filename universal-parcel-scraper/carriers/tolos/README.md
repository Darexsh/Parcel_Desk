# Tolos

Tolos parcels use enabled universal providers. There is no dedicated adapter.

Tolos is the brand of MOA Logistics (주식회사 모아 로지스틱스) in Seoul, which flies parcels from
Korea to Singapore, Taiwan, Malaysia and the United States, offers warehousing in Singapore and
shopping-agent services for Singapore and Taiwan. Its site is moalogis.kr, where tolos.asia leads.

## Numbers

Its tracker takes the house air waybill number and other references. No public page shows one,
so there is no rule. Parcels for Taiwan, the United States and Malaysia often continue under
another carrier's number, which the tracker shows.

## Why there is no adapter

The tracker on its home page posts the number to a JSON service without a session or CAPTCHA. No
public number has shown a known parcel's reply yet. An adapter can follow.

## Links

The tracker looks numbers up in place, and the home page does not read a number from its
address, so no address names one.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
