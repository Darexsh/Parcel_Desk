# Yuema Express

Yuema Express parcels use enabled universal providers. There is no dedicated adapter.

Yuema Express (玥玛速运), run by Yuema International Logistics (USA), is a forwarder in City of Industry,
California, shipping parcels from the United States to China, with branches in California and other US
cities and an overseas warehouse. Its site is yue777.com.

## Numbers

Its site gives no number layout. No public page shows a Yuema Express number, so there is no rule.

## Why there is no adapter

Its tracking page reads an open JSONP endpoint without a session or CAPTCHA:
`GET oa.yue777.com/Weixin/Hg/trace?bill={number}&callback={name}`, which takes several numbers separated by
commas. It answers an unknown number with HTTP 200, a `status` of 0 and 快递单号不存在 (no such waybill). As
the page reads a found parcel, its reply lists the scans with their times and adds the Chinese domestic
courier's number for the last leg. No public number is known to see a found reply.

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
