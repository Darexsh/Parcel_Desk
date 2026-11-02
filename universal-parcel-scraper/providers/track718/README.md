# Track718 for Juxi Express

Track718 is an opt-in universal provider restricted to Juxi Express's complete JXC identifiers.
It reports Track718 provenance and supplies no native carrier recognition. Other carriers
never reach this provider. Juxi's [published service terms](https://www.juxiex.com/product_show.php?id=76)
recommend Track718 alongside 17TRACK.

The scoped [TRAWL helper](../../trawl/README.md) opens the guest detail page with carrier 678.
The public client signs its tracking POST and identifies its WebSocket session. The helper
observes both before navigation, binds the complete identifier and Juxi source key, and retains
bounded tracking replies from that session. It returns scan fields without recipient details,
account data, tokens or the rendered page. No account is required.

The initial “Grabbing” response is a pending lookup. Only a completed matching response can
report no available history. A challenge, rate limit, busy service or unfinished lookup stays
a failure. Explicit scan offsets are preserved; clocks without an offset stay local and do
not acquire the carrier's default zone. An undated history can therefore need another provider.

For Juxi, the provider plan tries Track718 first and retains ParcelsApp, Ship24 and 17TRACK as
fallbacks. Track718 must still be explicitly enabled by the consumer. This order is
a routing policy, not a claim that Track718 always holds Juxi history.

## Testing

Set `FLARESOLVERR_URL` and a private `TRACK718_JUXI_TRACKING_NUMBER`, then run
`npm run test:carriers:live -- providers/track718/adapter.live.test.ts`.
