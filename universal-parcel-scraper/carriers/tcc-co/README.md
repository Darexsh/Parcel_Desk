# TCC

The native adapter reads TCC Colombia's public secondary history. TCCS in India is a separate carrier.

## Retrieval

The main tracking form verifies reCAPTCHA before its first search. Its detail view separately
posts to `tccrestify-dot-tcc-cloud.appspot.com/tracking/estados` with the whole remesa and
`infoadicional: "2"`. That read needs no CAPTCHA. The adapter sends the fixed `appId` header
that the official client gives every guest; no account credentials or browser are required.

The returned remesa must match the request. Dated history and novelty rows retain their stated
timestamp offsets and precision. A completed progress position can contribute the API's actual
delivery timestamp using the page's delivery label. Undated progress positions do not become
scans. Free-text observations and related remesas are discarded.

## Limitations

This feed can omit ordinary scans, so its history is marked partial and enabled providers can
supply a fuller timeline. Expired genuine remesas and unknown numbers share an empty success
reply; that remains inconclusive. Nine-digit remesas overlap other carriers, so tracking uses
an explicit carrier or a recognized TCC link. No number rule or HTTP recognition claims them.

The link parser accepts `documento` only when `tipo` is absent or names a remesa. Other form
types search sender references rather than tracking numbers.

## Testing

Use private inputs outside Git:

```sh
TCC_CO_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/tcc-co
```
