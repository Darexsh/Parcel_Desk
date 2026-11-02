# Yalidine

The native adapter reads Algerian guest-tracking history through TRAWL.

## Retrieval

The browser opens the blank form so its Turnstile response remains unused. The adapter then
posts the whole tracking number and that response to the same page through another browser
context on the service's egress. Only carrier-domain cookies enter that request. The HTTP tier
can classify the returned form as needing JavaScript and discard its response body.

A dedicated result card must identify the whole number. The scan table supplies wording,
location and the carrier's order. Its French weekday, day, month and time omit the year; those
validated clocks remain in `provider_time_text`. No lookup year, instant or freshness watermark
is invented. The presentation-only current-scan badge is discarded.

## Limitations

TRAWL is required. HTTP recognition never invokes this browser flow. Only the explicit
missing-parcel notice after a bound form POST establishes absence. Generic retry notices and
verification refusals remain challenges. The merchant dashboard and developer API require a
Yalidine account and are outside this guest flow.

## Testing

Use private inputs outside Git:

```sh
FLARESOLVERR_URL=… YALIDINE_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/yalidine
```
