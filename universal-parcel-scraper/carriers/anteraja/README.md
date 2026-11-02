# Anteraja

Reads Indonesian Anteraja waybills through its mobile guest tracking API.

## Retrieval

`POST https://api.anteraja.id/order/tracking` takes one `codes` entry. The public mobile
client and version headers select the guest route; no account, session or CAPTCHA is used.
The [consumer app](https://play.google.com/store/apps/details?id=id.anteraja.aca) offers
tracking by waybill alone. The website instead uses `api/trackparcel/getTrackStatus`
after an image CAPTCHA; both return the same shipment activity.

The reply must repeat the whole waybill. Carrier scan codes set known stages; unknown codes
remain unstaged. Short Indonesian status wording excludes courier and recipient names.
Only hub-labelled facility scans retain their location. Times have no offset and stay local;
the server's order is preserved when clocks tie. Names, addresses, booking references and
payment details are discarded.

## Limitations

Overlapping numeric formats remain low-confidence suggestions until HTTP recognition
confirms the waybill. Booking references are not supported. A removed guest route, a
verification page or a service error is not a missing shipment. Enabled universal providers
remain available when the direct service cannot answer.

## Testing

Set `ANTERAJA_TRACKING_NUMBER` outside Git and run
`npm run test:carriers:live -- carriers/anteraja`. `ANTERAJA_UNKNOWN_NUMBER` checks an unknown waybill.
