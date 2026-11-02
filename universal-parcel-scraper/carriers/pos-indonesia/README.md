# Pos Indonesia

Tracks Pos Indonesia waybills and postal items through the tracking service of Pos Indonesia's
mobile app.

## How it works

The [tracking page](https://www.posindonesia.co.id/id/tracking) looks a number up through a
server action that checks a Cloudflare Turnstile token. The adapter does not use it.

The Android app asks `GET https://jembatan.posindonesia.co.id/utility/2.0.0/tracking/{number}`
instead, with the app's key in `X-API-KEY`. The key is the same for every install. No account,
cookie, token or browser is needed. A request that fails to reach the service is sent once more
within the budget.

The answer is the waybill, then its scans. The waybill names the number it was made for, and
every scan names the item's number; each must be the whole requested number, because the service
also answers for a booking code. A `Data not found` notice, sent with HTTP 400, is a missing item.
A refused key and block pages are challenges. Other notices, an answer without scans, HTTP errors
and malformed answers keep their own failure kinds. Recognition uses the same lookup.

## Numbers

Pos Indonesia prints three layouts. Waybills are `P`, a six-digit posting date and seven digits,
which `pos-indonesia-1` suggests, so preflight asks the service about them. Older domestic
barcodes are eleven digits, which other carriers print too and no rule claims. International
items carry UPU S10 numbers; the service also tracks items from abroad once Pos Indonesia handles
them. Postal detection keeps S10 numbers with the generic postal carrier; one ending `ID` only
suggests Pos Indonesia, which recognition asks first. An S10 item from abroad bound for Indonesia
is handed to Pos Indonesia under the sending post's number. The adapter takes all three, an S10 number only with a
valid check digit, and treats anything else as invalid without a request.

## Notes

Each scan carries a state, an action, its wording, an offset-less clock and the office. The
adapter maps the states it has seen; a state the map does not know goes to the shared wording
rules. The service sorts scans by clock, and the adapter lists them newest first.

Indonesia keeps three time zones and the service names none, so scan clocks stay local times.

The wording names the staff member who scanned the item, and a delivery names the recipient and
how they relate to the addressee. The adapter drops them, phone numbers, and the office codes
after office names, which carry postcodes. A scan without wording reads as its action. The
waybill's sender, recipient, addresses, service code and price are not read; its weight, in
grams, is kept in kilograms, and its destination gives the country.

For an item it holds no waybill for, inbound items among them, the service fills its waybill
template with nothing for numeric fields, which is not JSON. The adapter reads those fields as
empty and keeps the scans.

## Limitations

The service leaves out scans the tracking page shows, and has no scans from the foreign posts an
international item passes through, so every answer is marked as part of the history. The answer
has no delivery estimate or pickup point. The service did not find the eleven-digit barcodes
and some of the international items public reports give, so their coverage is unconfirmed.

## Links

The tracking form opens `posindonesia.co.id/id/tracking/{number}`, or `/en/` for the English
page, and the library reads the number from either. Older pages passed it as `resi` on
the tracking page, which the library also reads.

## Live test

Set `POS_INDONESIA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/pos-indonesia/adapter.live.test.ts`.
Optionally set `POS_INDONESIA_UNKNOWN_NUMBER` to check a number the service does not know.
