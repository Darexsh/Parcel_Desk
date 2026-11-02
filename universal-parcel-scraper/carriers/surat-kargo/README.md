# Sürat Kargo

Tracks Sürat Kargo through the merchant tracking link and its guest piece-history lookup.

## Retrieval

One `direct` step opens `www.suratkargo.com.tr/KargoTakip/?kargotakipno={number}` with a fresh
cookie jar. This numbered link opens the parcel without submitting the search form's CAPTCHA.
The page masks its visible identifier: its prefix and length are checked, and the response
belongs to the GET for the whole number, with redirects refused.

Each unique piece capability from that page opens `POST /KargoTakip/Default/KargoHareketi` as
JSON in the same guest session. Desktop and mobile copies of one capability are queried once.
The adapter retains operational scan labels and offices, with local clocks and deduced Istanbul
instants. Recipient details, signatures and delivery addresses are excluded; guest capabilities
are omitted from results and transport diagnostics. A shipment remains active while any piece
is undelivered.

An unknown number can return an empty search form rather than an explicit missing answer.
That stays inconclusive. Block pages, failed verification, rate limits and changed replies keep
their own failure kinds.

## Network access

The tracking site requires Turkish egress. Consumers supply a scoped `fetcher` through the
adapter environment and keep proxy credentials private. No account or browser is required.

## Numbers

The tracker and customers use fourteen-digit tracking numbers. Fourteen digits are shared with
Russian Post and other carriers, and no checksum is known, so no rule claims them. The tracker
also takes the sender's web order code, which is not a tracking number.

## Links

The tracker reads the number from `kargotakipno`, so
`suratkargo.com.tr/KargoTakip/?kargotakipno={number}` opens one parcel, as archived lookups
show.

## Testing

Set `SURAT_KARGO_TRACKING_NUMBER`, optionally `SURAT_KARGO_UNKNOWN_NUMBER`, and
`SURAT_KARGO_PROXY_URL` outside Git, then run:

```sh
npm run test:carriers:live -- carriers/surat-kargo
```
