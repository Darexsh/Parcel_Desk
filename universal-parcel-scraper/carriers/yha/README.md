# YHA Logistics

YHA Logistics parcels use enabled universal providers. There is no dedicated adapter.

YHA Logistics (越航物流) is a Shenzhen forwarder with offices in Hong Kong, the United States and
Australia, shipping through the express integrators, Amazon FBA and its own air and sea lines. Its
site is yha56.com.

## Numbers

Its site gives no number layout and no public page shows a YHA number, so there is no rule.

## Why there is no adapter

The tracking page asks an open JSON endpoint, `GET www.yiwenjin.cn/system-service/api/trace/getTraceList`,
without a session or CAPTCHA. The request names no forwarder and the service looks shared by
several, so a found answer alone would not show that the number is YHA's. No public number is
known to see a found reply.

## Links

The tracking page opens the number from its `manifestId` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
