# TIKI

Tracks TIKI resi numbers through the tracking service of TIKI's Android app.

## How it works

The [tracker](https://tiki.id/id/track) on tiki.id posts its form with a reCAPTCHA token. The
adapter does not use it.

The Android app asks `POST https://my.tiki.id/api/android/v4/connote/information` instead, with
the resi as `cnno` in a JSON body and a token in `Authorization`. The token is an HS256 JWT for
the subject `tiki`, valid for 100 seconds and signed with the app's key, which is the same for
every install. No account, cookie or browser is needed. The service refuses a token issued in its
future, so the adapter dates its tokens 50 seconds back; a host clock further off than that gets
its tokens refused. A request that fails to reach the service is sent once more within the budget.

The answer lists the consignment's pieces, and every piece must name the whole requested number.
An empty list is a missing resi. A refused token, answered with HTTP 403, and block pages are
challenges. Other notices, HTTP errors and malformed answers keep their own failure kinds.
Recognition uses the same lookup.

## Numbers

TIKI prints a twelve-digit resi. Many Indonesian carriers print twelve digits, so there is no
detection rule and preflight does not ask TIKI: a number is matched to TIKI only when the user, a
link or a provider names the carrier. The tracker shows a consignment of several pieces with a
suffix per piece, which the service does not take; the adapter treats anything but twelve digits
as invalid without a request.

## Notes

A consignment of one piece is one entry; one of several lists each piece with its own history.
The adapter merges the histories and keeps a scan the pieces share once. A delivery or return
decides the consignment's stage only when every piece has one; until then the newest scan of a
piece still travelling does.

Each scan carries a code, an offset-less clock, the office with its town and the wording. The
adapter maps the codes it has seen; a code the map does not know goes to the shared wording rules.
Indonesia keeps three time zones and the service names none, so scan clocks stay local times. A
scan without a town of its own takes the town in brackets after its office's name.

A delivery names the receiver and how they relate to the addressee, sometimes with a phone
number, and a return names the sender. The adapter drops them and phone numbers. The product code,
such as `REG`, is the service name; the weight is kept when every piece gives the same one, and the
estimated delivery day until the consignment is delivered or returned. Sender, recipient, their
provinces, fees and the proof-of-delivery image are not read.

## Limitations

The answer has no delivery instant with an offset, no destination country and no pickup point.

## Links

The tracker opens `tiki.id/id/track/{number}` with the number in its search form, and the library
reads the number from that address.

## Live test

Set `TIKI_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/tiki/adapter.live.test.ts`.
Optionally set `TIKI_UNKNOWN_NUMBER` to check a number the service does not know.
