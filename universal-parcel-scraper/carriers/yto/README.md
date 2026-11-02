# YTO Express

Tracks Chinese domestic waybills through the official website's consumer feed.

## How it works

1. `direct`: one anonymous JSON POST returns an identity-bound scan list. The website
   displays a slider before querying; the feed accepts reads without cookies or a
   challenge token. The adapter uses each scan's operation code and preserves the
   feed's newest-first order.
2. `retry`: a read that fails to reach the site, or hangs, runs once more within the
   budget, on www.ytoexpress.com, YTO's other domain for the same site. The first read
   gets half of the budget. An HTTP status or a reply is never sent again.

www.yto.net.cn resolves to a CDN edge that changes every minute, and some edges take no
connection from abroad, so a retry on the same name meets the same dead edge.
www.ytoexpress.com, under YTO's own certificate, serves the same feed from YTO's addresses.

## Notes

Domestic scan clocks use China time. Invalid dates remain unresolved. Return dispatch
keeps subsequent movement, collection and signature scans on the return to the sender.
Return transit remains active; only a completed sender signature is terminal.
Short operation labels and depot names are retained; expanded descriptions containing
courier contacts, recipient details and collection addresses are excluded.
Known labels are shown in English, and rows stored with the Chinese label take the
English in place.

Relayed Chinese labels and their ParcelsApp translations use the same vocabulary as
direct scans. ParcelsApp's UTC-labelled China clocks are read in the catalog timezone.

## Limitations

An echoed number with no scans, as YTO answers for a waybill not scanned yet, is no history
(`NoHistoryError`): inconclusive, not a failure of the lookup. Archived histories and international
YTO Global shipments use separate website flows and are outside this adapter's scope.

## Testing

Set `YTO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/yto/adapter.live.test.ts`.
