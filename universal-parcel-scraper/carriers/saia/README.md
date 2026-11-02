# Saia

Tracks freight through the HTTP service behind Saia's public tracker. The adapter opens a
fresh tracking session, then sends the encrypted PRO with the session's XSRF cookie and the
shared API and cipher keys published in the tracker's script. No customer account is used.
A failed connection gets one more attempt within the lookup budget.

The reply must name the requested PRO. Only the service's missing-shipment notice for that
PRO is not-found. Refused sessions, firewall blocks, rate limits and malformed replies stay
separate.

Scan clocks have no offsets and remain local. The shipment's status can be newer than its
history. The adapter keeps terminal locations, the estimate and weight, and excludes parties,
signatures, document links and driver details.

## Numbers

A Saia PRO is eleven digits. Saia's tracker calls a twelfth digit a check digit and leaves it
off when it searches, and the service refuses twelve digits, so a twelve-digit input is looked
up as its first eleven and the result names those as the canonical number. On every public
twelve-digit PRO the eleventh digit is 0 and the twelfth is the remainder of the first ten
divided by seven; Saia does not publish that, so the `saia` checksum checks only that form.
`saia-1` suggests Saia at low confidence for twelve digits that pass it, as one of several
twelve-digit carriers. Eleven digits are not distinctive, so no rule claims them.

Recognition answers only for eleven digits. Saia never sees the twelfth digit, so a reply cannot
bind a twelve-digit number, and the check digit alone does not make it Saia's. Preflight does
not ask Saia about one; the user picks Saia from the suggestions.

## Limitations

Saia's firewall refuses some networks and browser clients. Those failures can pass to enabled
universal providers. The service also warns against unauthorized API access; the adapter uses
the public tracker's request and shared keys.

## Live test

Set `SAIA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/saia/adapter.live.test.ts`.
`SAIA_UNKNOWN_NUMBER` optionally checks an unknown PRO.
