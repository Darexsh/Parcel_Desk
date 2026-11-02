# DAO

Tracks parcels of DAO, the Danish home-delivery and daoSHOP network, through the service its
tracking page asks.

## How it works

`dao.as/find-din-pakke/` asks `GET https://dao.as/wp-json/dao-wp/v1/track-parcel?barcode={number}&lang=EN`
for the parcel. The page sends its WordPress nonce, which the service does not need without a
session cookie, and no CAPTCHA token; the adapter sends neither. A request that fails to reach DAO
is sent once more within the budget.

A number the service does not know, including a malformed one, comes back as `{"found":false}`,
so it is not found. A known parcel without scans, which older numbers return, has no history. The
reply must name the requested SSCC. A missing route, a rejected request, block pages, HTTP errors
and malformed replies keep their own failure kinds. Recognition uses the same lookup.

## Numbers

DAO's tracker says its numbers are twenty-digit SSCCs starting `00057`, thirteen digits starting
`7` and the nine-digit code a sender writes on a parcel without a label. The adapter checks an
SSCC's GS1 check digit and sends the other two forms as typed; a reply may name the parcel's SSCC
for them, which becomes its canonical number.

DAO issues SSCCs under its own GS1 company prefixes: `5715127` carries one dense serial run across
several senders' parcels, and `5712696` is the prefix of the example in DAO's customer
documentation, which the tracker still knows. `dao-1` suggests DAO for SSCCs under either prefix,
and preflight asks it. PostNord's broader rule for Danish SSCCs also fits them. An SSCC under
another prefix names whoever issued it, so no rule offers DAO for it, and nor does a rule cover the
shorter forms, which many carriers print.

## Notes

Each scan has a clock, an event number, a leg and Danish or English wording. DAO numbers events
separately for home delivery and daoSHOP, so the adapter keeps both as `Home/11` and stages the
pair: `Home/11` is a delivery, `Shop/11` an arrival at a terminal. A home delivery's scan carries
its delivered text in the place field. A failed home delivery continues on the `Shop` leg.

The pickup point is named alone. A parcel sent abroad keeps the partner's number as the delivery
tracking number, and the partner when its tracking link names one. The masked sender and
recipient, the recipient's postcode and the pickup point's address, opening hours and coordinates
are not read.

## Limitations

The service gives scan clocks without an offset, so they stay local wall clocks. No live reply
carried a partner number, and the thirteen-digit and e-label forms were not checked live.
The business tracking API at `api.dao.as` needs a customer id and code, and the DAO app's API at
`apiv2.dao.as` needs a signed-in user's token.

## Links

DAO's tracker puts the number in the address fragment, as `#q={number}`, and reads it from there
when the page opens. Older links from DAO's own site carry it in the `q` or `stregkode` parameter
of that page, of its English `track-your-parcel` page, of the home page or of the `dao-app` page;
the library reads all of them.

## Live test

Set `DAO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/dao/adapter.live.test.ts`.
Optionally set `DAO_UNKNOWN_NUMBER` to check a number the service does not know.
