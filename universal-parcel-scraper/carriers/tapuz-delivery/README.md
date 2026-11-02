# Tapuz Delivery

Tapuz Delivery parcels use enabled universal providers. There is no dedicated adapter.

Tapuz Delivery (תפוז שליחויות) is an Israeli courier delivering online shops' parcels across Israel with its own
couriers, same day or next day. Shops book it through its API and its Shopify and Wix apps. Its site is
tapuzdelivery.co.il.

## Numbers

Its tracker looks up delivery numbers from Baldar, the courier-management system it runs on. No public page
shows one, so there is no rule.

## Why there is no adapter

Its tracker posts the number to an open ASP.NET page method without a login or CAPTCHA:
`POST crm.tapuzdelivery.co.il/Baldar/DeliveryStatus.aspx/GetStatus` with a JSON body holding `deliveryNumber`
and `customerCode` -1. The lookup also matches the input against other fields of a delivery, so it can answer
with an unrelated delivery: an adapter must accept a reply only when its delivery number equals the input
exactly. The reply names the receiver, which an adapter must not keep. No public number is known to see a
found reply.

## Links

Its tracker reads the number from a text box only, so no link names it. The catalog checks the tracker's host,
since the main site turns away repeated requests.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
