# X Express

X Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

X Express shipment numbers are X or A followed by nine digits, or eight digits, as the tracking
page and the guide to the shipment-booking app show. No rule claims them: the A layout falls in
Allegro One's range, and the other layouts are short shapes other carriers print.

## Links

None. The tracking page posts the number with a reCAPTCHA and a small sum check, so no address
opens one parcel.

## Why there is no adapter

The tracking page posts the number with a reCAPTCHA v3 token it fetches as it loads, and X
Express has no app that tracks parcels. So X Express parcels stay on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
