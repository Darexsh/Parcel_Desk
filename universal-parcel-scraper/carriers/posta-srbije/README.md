# Pošta Srbije

Tracks Pošta Srbije items through the tracking service of Pošta Srbije's mobile app.

## How it works

The [tracking page](https://www.posta.rs/cir/alati/pracenje-posiljke.aspx) is an ASP.NET form
that sends a reCAPTCHA v3 token with each lookup, and the server checks it: a postback without
one returns a verification error instead of the item. Post Express's tracking page posts the
number to the same form. The adapter does not use them.

The Android app asks `POST https://api.posta.rs/paketi` instead. Its JSON envelope carries the
app's client, whose user and password are the same for every install, the service and
transaction codes for item tracking, a fresh transaction id, and the number as JSON text. The
adapter sends the same request, asking for English wording. No account, cookie, CAPTCHA token or
browser is needed. A request that fails to reach the service is sent once more within the budget.

The answer has a result code and carries the history or a notice as JSON text. Every event names
the item's number, and each must be the whole requested number. A notice that no item was found,
in English or Serbian, is a missing item; the service gives it for a malformed number too. A
refused app password is a challenge. Other notices, an answer without events, block pages, HTTP
errors and malformed answers keep their own failure kinds. Recognition uses the same lookup.

## Numbers

Pošta Srbije tracks UPU S10 items. Its own end `RS`, as do those of Post Express, its courier
arm. The adapter takes S10 codes with a valid check digit, from any country, and treats anything
else as invalid without a request. Its tracker relays the foreign post's events for its parcels,
EMS, letter and registered items sent abroad, so detection names it for codes ending `RS` that
start C, E, L or R (`posta-srbije-own`). Other codes ending `RS` stay with the generic postal
carrier, since M-ONE uses its P series, and the low-confidence `posta-srbije-s10` rule makes
preflight ask Pošta Srbije about them first.

## Notes

Each event carries a short code, its wording, an offset-less clock and a place; events come newest
first and keep that order. The adapter maps the codes it has seen. The English wording is terse,
a foreign post's failed delivery keeps its Serbian wording, and a delivery back to the sender
reads as a delivery, so the codes decide; a code the map does not know goes to the shared wording
rules. A delivery the service flags as a return is the sender's.

A Serbian office comes with its five-digit number, which is its postcode and is dropped; the
office's name stays and its events are dated on Belgrade's clock. A foreign post's events name its
country and an office code that can be a postcode; only the country is kept. They come on that
country's wall clock, so they are dated on its clock when it keeps one and otherwise stay local
times. A Serbian office of exchange given by its UPU code is placed in Serbia.

The weight is the one taken at acceptance, in grams, kept in kilograms. The signer, the office an
event sends the item to, cash-on-delivery documents and the service's own ids are not read.

## Limitations

The service drops an item's history some time after delivery, after which it answers like an
unknown number. An item sent to Serbia from abroad answers under the sending post's number with
the inward exchange office's and Serbian offices' scans, so a parcel to Serbia is handed to it.
Post Express shipments were not seen with history, so their coverage is unconfirmed. The answer
has no delivery estimate or pickup point.

## Links

Archived lookups put the number as `broj` on the tracking page, in its Cyrillic, Latin or English
version, and the library reads it there. The live page ignores it, so no link opens one item.

## Live test

Set `POSTA_SRBIJE_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/posta-srbije/adapter.live.test.ts`.
Optionally set `POSTA_SRBIJE_UNKNOWN_NUMBER` to check a number the service does not know.
