# Slovenská pošta

Tracks Slovenská pošta items, its own and those other posts send to Slovakia, through the service
behind its tracking page.

## How it works

The [tracking page](https://www.posta.sk/sledovanie-zasielok) asks
`GET https://api.posta.sk/private/web/track?q={number}&mmpc=1` from the visitor's browser, and
the adapter sends the same request. No account, cookie, key, CAPTCHA token or browser is needed.
`mmpc=1` asks for the parts of a multi-piece item, as the page always does. A request that fails
to reach the service is sent once more within the budget.

The answer lists items, and one must name the whole requested number as its `barcode`. A number
the service does not know comes back with the error `not_found`, which is a missing item. A number
a sender holds but has not posted (`not_found_assigned`) reads as a registered item without
events. A number the service has no data for, an item type it does not track, other errors, the
F5 firewall's block page, HTTP errors and malformed answers keep their own failure kinds.
Recognition uses the same lookup.

Slovenská pošta also documents a T&T REST API on `api.posta.sk/tracking`, linked from its
[developer page](https://www.posta.sk/podpora/dokumentacia-pre-vyvojarov). It answers an unknown
number with the same empty list as an item without events, and it has no countries, weight or
item state, so the adapter does not use it. Its manual lists the event codes the adapter maps.

## Numbers

Slovenská pošta tracks UPU S10 items: its own end `SK`, registered items starting `R`, parcels
`C` and EMS items `E`. The adapter takes S10 codes with a valid check digit, from any country,
and treats anything else as invalid without a request. Detection names Slovenská pošta for the
EMS, parcel, registered and tracked-letter items it issues: `C`, `E`, `L` or `R` first, `SK` last
and a passing check digit. Its tracker follows them to delivery, abroad included, as Chunghwa
Post's follows its own. Its other `SK` codes stay with the generic postal carrier, and a
low-confidence rule makes preflight ask Slovenská pošta about them.

Mail from abroad reaches Slovenská pošta when a caller names it, a provider names it, or a result
gives Slovakia as the destination of an S10 item. Its tracker follows such items under the sending
post's code to delivery.

## Notes

Each event carries a code, English and Slovak wording, a clock and either a Slovak branch or a
country. The adapter maps the codes: Slovenská pošta's own, and cross-border items' UPU events,
sent as `IPS_` and the UPU letters with `THERE` or `BACK` for the direction. A code the map does
not know goes to the shared wording rules. A change of delivery day or collection period keeps
the stage of the event before it. After an event that sends the item back, a delivery is the
sender's and reads as returned. Events keep the service's order, newest first.

The service sends each event's local wall clock as if it were UTC: the tracking page reads it with
UTC getters and notes that its times are local, the documented API sends the same digits as a
local date, and posting and collection times fit the branches' opening hours only when read so.
A Slovak event is dated on Bratislava's clock. An event abroad is dated on its country's clock
when that country keeps one, and otherwise keeps its wall clock as a local time.

A Slovak event's place is the post office, BalíkoBOX or PoštaPOINT by the name the page shows,
with the town for the last two; older wordings carry a placeholder the page fills with it. An event
abroad is placed in its country. The pickup point is the branch the item's state says it waits at,
or the branch of the event that made it ready for collection, while it waits there or once it was
collected there, unless the item was sent back. Branch addresses, postcodes, coordinates and phone
numbers are not read, nor are the collection deadline, sender's country, item category, services,
cash on delivery, insurance, receipts or delivery changes. Without events, the item's state is read
as a summary.

## Limitations

The service keeps an item's history for a limited time, after which the item answers like an
unknown number. Some item types are not tracked. The answer has no delivery estimate.

## Links

The tracking page reads the number from the address fragment, `#parcel={number}`, and the library
reads it there. Lookups archived from the former tracker put the number in
`tandt.posta.sk/en/items/{number}`, `tandt.posta.sk/zasielky/{number}` or as `q` on
`tandt.posta.sk/`; all now redirect to the new tracker without the number.

## Live test

Set `SLOVENSKA_POSTA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/slovenska-posta/adapter.live.test.ts`.
Optionally set `SLOVENSKA_POSTA_UNKNOWN_NUMBER` to check a number the service does not know.
