# SiCepat Ekspres

SiCepat Ekspres parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

SiCepat resi numbers are twelve digits starting `00`. SiCepat's own replies to complaints on
Media Konsumen give them. Twelve digits are also FedEx's and other carriers' layout, and the
`00` start does not set SiCepat apart, so no rule claims them.

## Links

SiCepat's tracker reads the number from its form. No address opens one parcel.

## Why there is no adapter

SiCepat's tracker and app ask for a reCAPTCHA token, and for some waybills the last five digits
of the recipient's phone, before they show a parcel.

The web client posts to `api.sicepatconsumer.com/v2/contentsvc/public/validate-awb-id` with
`awb_number` and a fresh `x-recaptcha` token for action `checkAwb`. Ordinary waybills then use
`check-awb` under the same prefix with an empty `awb_id` and `awb_number`, after fresh
verification. For the other branch the page sends the phone digits as `awb_id`. The Android app
(`com.sicepat.consumer`) asks `GET api.sicepatconsumer.com/v1/order/public/shipping/awb/{number}`
with the same kind of token; the content-service routes left in it are no longer called and no
longer answer. Both services refuse a missing or failed token for made-up numbers too, so the
refusal says nothing about the number, while a missing waybill gets an explicit `Not Found`
reply. The library solves no captcha, so SiCepat stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
