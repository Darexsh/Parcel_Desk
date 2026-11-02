# AQX Logistics

AQX Logistics parcels use enabled universal providers. There is no dedicated adapter.

AQX Logistics, a forwarder in Inglewood, California, ships parcels from the United States to the Gulf
states, the United Kingdom, Europe, Australia and New Zealand. Its site is aqxlogistics.com.

## Numbers

Its tracker takes AQX's own shipment reference, HF- and eight hexadecimal characters, or the DHL
Express waybill that carries the parcel. One example number is known, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service with the number alone, without a login or CAPTCHA. Its example
shows only AQX's own registration event; the movement is DHL Express's, under the waybill the reply
links. An adapter that hands the parcel to DHL Express can follow.

## Links

Tracking links carry the number as `id` on the `track` page at aqxlogistics.com.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
