# ComOne Express

ComOne Express parcels use enabled universal providers. There is no dedicated adapter.

ComOne Express (商壹国际物流) is a Shenzhen forwarder founded in 2011, with its own companies in Malaysia,
Singapore and Hong Kong, carrying parcels from China to Southeast Asia. Its site is com1logistics.com.

## Numbers

Its site gives no number layout and no public page shows a ComOne Express number, so there is no rule.

## Why there is no adapter

Its tracking page posts the number to an open JSON endpoint without a session or CAPTCHA: first
`POST service.com1logistics.com//pod/track/formatNumbers`, then `POST service.com1logistics.com//pod/track/query`
with `number`. An unknown number gets an empty `data` array. No public number is known to see a found reply.

## Links

The tracking page opens the number from its `trackNo` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
