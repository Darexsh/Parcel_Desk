# Profit Fields

Profit Fields parcels use enabled universal providers. There is no dedicated adapter.

Profit Fields (永利八达通, 8DT) is a Shenzhen forwarder running packet lines from China to North
America, the UK and Europe, handing parcels to the destination post. Its site is 8dt.com.

## Numbers

Its numbers are `EWS`, a two-letter destination, ten digits and `YQ`, which `profit-fields-1`
suggests at low confidence; the only public example is an archived lookup on its old tracker. Its
tracker also takes the destination carrier's number, which stays with that carrier.

## Why there is no adapter

Its tracking page posts numbers to a JSON API without a session or CAPTCHA, and the API answers
an unknown number with an explicit not-found. No current public number is known to confirm a
found reply.

## Links

The tracking page opens a number from its `track` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
