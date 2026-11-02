# Česká pošta

Tracks Česká pošta items, Balíkovna parcels among them, through the public B2C tracking service
Česká pošta documents on `b2c.cpost.cz`.

## How it works

The adapter sends one `GET` to
`https://b2c.cpost.cz/services/ParcelHistory/getDataAsJson?idParcel={number}&language=en`. No
account, cookie, key or browser is needed. The service answers the same rows as the
[Track & Trace page](https://www.postaonline.cz/trackandtrace), which renders them on the server.
A request that fails to reach the service is sent once more within the budget.

The answer must hold one item that names the whole requested number. An unknown number comes back
with a single "no record" row (`-3`), and only that answer is a missing item. A row saying
Česká pošta does not show the item's type (`-4`), a notice next to real rows, an error object, an
F5 block page, HTTP errors and malformed answers keep their own failure kinds. Recognition uses the
same lookup.

## Numbers

Domestic items carry two letters, ten digits and a letter: `DR` for parcels and Balíkovna
parcels, `BA`, `BB`, `BX` and others for registered and valuable items. Lookups archived from
Track & Trace also show `NB`, `NP` and `NR` items. `ceska-posta-1` claims a `B` or `D` prefix and
those three in that layout; the adapter takes any prefix. Nothing published explains the
trailing letter, so no check is applied. The adapter also takes S10 codes with a valid check
digit, from any country; anything else is invalid without a request.

A code ending `CZ` is Česká pošta's, but the issuer of an S10 code does not establish who
delivers it, so detection keeps such codes with the generic postal carrier. A low-confidence
rule makes preflight ask Česká pošta about them.

Mail from abroad reaches Česká pošta when a caller names it, a provider names it, or a result
gives Czechia as the destination of an S10 item. Its service follows such items under the sending
post's code to delivery.

## Notes

Each row carries a state code, a calendar day without a time, English wording and the office or
depot. The adapter maps the codes; a code the map does not know goes to the shared wording rules.
Text and email alerts to the recipient, and the row with the courier's position at a delivery
attempt, keep the stage of the row before them. A row the service adds to every answer, pointing
to the customer line (`-1`), is dropped.

Rows of one day come oldest first, and the days are not always in order. The adapter sorts them
newest day first and reverses each day's rows, as the tracking page does. Days are kept as local
calendar days.

After a code that sends the item back, a delivery is the sender's and reads as returned. The
pickup point is the post office or Balíkovna point named by the row that made the item ready for
collection, while it waits there or once it was collected there, unless the item was sent back.

Rows carry the office's postcode, and some carry coordinates and an attempt time that can place
the recipient; none of them is read. Neither is the contact phone, cash on delivery or the
collection deadline.

## Limitations

The service keeps an item's history for a limited time, after which the item answers like an
unknown number. Some item types answer that Česká pošta does not show them. The answer has a
type code but not the service name the tracking page shows. Its expected delivery fields have not
been seen filled, so no estimate is read.

## Links

Track & Trace opens an item at `postaonline.cz/trackandtrace/-/zasilka/{number}`. Its search form
sends numbers as `parcelNumbers` to `/trackandtrace/-/zasilka/cislo`, and both are read with or
without a language segment such as `/en`.

## Live test

Set `CESKA_POSTA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/ceska-posta/adapter.live.test.ts`.
Optionally set `CESKA_POSTA_UNKNOWN_NUMBER` to check a number without a record.
