# POST Luxembourg

Tracks POST Luxembourg items, its own and those from other posts it delivers in Luxembourg,
through the anonymous service behind its Track and Trace page.

## How it works

The Track and Trace page on `www.post.lu` loads an Angular app that posts the numbers to
`POST https://api.post.lu/services/trackandtrace-api/items` as `{"ids": [...]}`. The adapter
sends that one request for one number, in English (`Accept-Language: en`; the service answers
French otherwise). No account, cookie or browser is needed, and the page has no CAPTCHA. POST's
API gateway only wants the client id the page sends as `X-IBM-Client-Id`, the same for every
visitor, which the page reads from `www.post.lu/ng-conf/trackandtrace-web.json`; the adapter
carries it. A request that fails to reach the service is sent once more within the budget.

The reply has one entry per number, naming it, with its events or an error word. An entry for
another number is a schema failure. `item.not.found` without events is the only missing item;
the service gives it both to unknown numbers and to text that is not a number. Another error word, an
empty history, a batch still being looked up, a block page, HTTP errors and malformed replies
keep their own failure kinds. Recognition uses the same lookup.

The official app, Parcels & Mail (`lu.post.courrier.mobile`), follows parcels through MyPost
account requests on `id.post.lu`, so it offers no guest route.

## Numbers

The adapter takes S10 codes with a valid check digit, from any country; anything else is invalid
without a request. POST Luxembourg's own items end `LU`, and items from abroad answer under their
foreign S10 code.

A code ending `LU` is POST Luxembourg's, but the issuer of an S10 code does not establish who
delivers it, so detection keeps such codes with the generic postal carrier. A low-confidence rule
makes preflight ask POST Luxembourg about them.

## Notes

Each event carries a day, a UPU event code, its wording and sometimes the office or facility.
The service gives no time of day, so events keep their day as a local date, and days from a
destination post are that post's. Within a day, events follow the service's own order, newest
first. The map stages the codes seen in replies; others go to the shared wording rules. The page's
progress step and each event's category are not read.

Items sent abroad include the destination post's events, mostly without a place.

## Limitations

Customs, failed-delivery, pickup and return codes have not been seen live; their events are
staged by their wording until the map knows them, and no pickup point is read. An item whose
history the service no longer keeps answers like an unknown number.

## Links

The page reads the number from its address fragment, `#/search?numero={number}`, looks it up and
moves to its result view. `www.trackandtrace.lu/?numero={number}` redirects there.

## Live test

Set `POST_LUXEMBOURG_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/post-luxembourg/adapter.live.test.ts`.
Optionally set `POST_LUXEMBOURG_UNKNOWN_NUMBER` to check a code without history.
