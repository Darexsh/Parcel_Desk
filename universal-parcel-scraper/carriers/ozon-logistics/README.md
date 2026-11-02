# Ozon

The adapter reads Ozon posting histories from its public guest tracker through TRAWL.
Ozon Rocket shop references still use enabled universal providers.

## Limitations

The [public tracker](https://tracking.ozon.ru/) runs Ozon's browser verification before
`GET /p-api/ozon-track-bff/tracking/{posting}` answers. The scoped TRAWL helper opens a fresh
guest context, waits for the form and makes that same-origin GET with `x-o3-app-name:
tpl-ui-ozon-track`. It reads the decoded response through a bounded stream because the service's
generic capture does not retain compressed bodies. Deploy the matching [TRAWL image](../../trawl/README.md).

The reply does not repeat the posting, so the capture binds its whole request path and submitted
identifier. Only the carrier's exact missing-posting reply means not found. Blocked, incomplete
and malformed replies remain failures. HTTP recognition makes only the direct request; browser
recognition is a separate opt-in phase and retains the confirmed history.

The API includes the timeline hidden behind the page's expansion control. Scan timestamps keep
their stated offsets and equal-time events retain their order. Phantom progress rows are display
placeholders, not scans. Delivery estimates are calendar dates. Pickup and courier deliveries
share the `Received` event; the adapter follows the page's delivery-type wording.

The [Ozon Android app](https://play.google.com/store/apps/details?id=ru.ozon.app.android)
uses authenticated customer-order widgets behind its native bot check; it supplies no guest
alternative to this tracker. Rocket's separate API has no verified positive response, and old
or unsupported postings can be absent from the public tracker.

## Numbers

Ozon posting numbers are an order number of eight or ten digits, four digits and one digit,
joined by hyphens, as archived lookups on Ozon's trackers show. `ozon-logistics-1` claims them
when they are printed with their hyphens; without them the digits match other carriers'
numeric shapes. Ozon Rocket, the delivery service Ozon offered to other shops, tracked their
orders as `PL-`, a six-digit client code and the shop's own reference; `ozon-logistics-2`
claims that printed form. Ozon's tracker also shows numbers of partner carriers, mostly
Chinese postal items, which stay with those carriers.

## Links

The tracker at `tracking.ozon.ru` reads the number from its `track` parameter, so
`tracking.ozon.ru/?track={number}` opens one parcel. Ozon Rocket's tracker at
`rocket.ozon.ru/tracking/` takes it as `SearchId`.

## Testing

Set `FLARESOLVERR_URL` and a private `OZON_TRACKING_NUMBER`, then run
`npm run test:carriers:live -- carriers/ozon-logistics/adapter.live.test.ts`.
