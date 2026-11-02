# Roadie

Roadie deliveries use the carrier's anonymous tracking API through the host's supplied transport.

## Numbers

Roadie's tracker takes the delivery id from Roadie's notification links. Lookups archived from
the tracker show two layouts, which its script treats apart: `1R` and 26 letters and digits,
sent in capitals, and `1R` and 14 hexadecimal digits, sent in lower case. `roadie-1` and
`roadie-2` claim them.

## Links

The tracker opens one delivery at `track.roadie.com/id/{number}`. It redirects
`/track/{number}` and `/track?tracking_number=` there, also behind a partner theme prefix.

## Retrieval

The adapter reads a delivery from `GET api.roadie.com/gigs/{number}/track`, with the public
client's version-three Accept header and no key or sign-in. Its array must contain one delivery
whose whole tracking number matches. It retains shipment events and explicit scan offsets;
later writes of delivery proof do not move the last shipment milestone. An identified expired
delivery is an exception, while the API's empty HTTP 404 is a missing delivery. A blocked page
or malformed reply stays a failure.

The delivery's ZIP code only unlocks the address, photos and driver; these are not requested.
Sender contact details and recipient data are dropped. That API refuses
requests outside the United States, as the [official API FAQ](https://docs.roadie.com/)
explains. The block also reaches the browser tracker, whose error screen calls any lookup
failure a missing delivery. A browser or CAPTCHA solver alone cannot fix this network gate.

The [Roadie Driver Android app](https://play.google.com/store/apps/details?id=com.roadie.drive.android.app)
is signed by the certificate published in [Roadie's app links](https://drive.roadie.com/.well-known/assetlinks.json).
Its REST client uses the same `api.roadie.com` host; its `drive-server.roadie.com/graphql`
client serves signed-in driver work. No separate guest tracking route was found there.
Configure US egress in the host's supplied fetcher. The adapter does not own proxy credentials
or route unrelated providers through that connection.

## Testing

Set private `ROADIE_TRACKING_NUMBER` and `ROADIE_PROXY_URL`, then run
`npm run test:carriers:live -- carriers/roadie/adapter.live.test.ts`.
