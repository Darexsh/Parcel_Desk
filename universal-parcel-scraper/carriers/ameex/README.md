# Ameex

Ameex parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Ameex is a Moroccan e-commerce delivery company. Its parcel codes start with a three-letter
city code, then four digits for the month and year, the letter B with more characters, and a
run of digits. The tracker form shows one as its placeholder, and merchant integrations on
GitHub quote others. The FAQ on the tracker page describes an AMX code with a year and serial;
no such code has been found.

No rule claims these codes. The city codes are shared with other Moroccan couriers, the length
varies, and the few public codes do not fix the layout well enough.

## Links

The tracker opens one parcel at `/{locale}/tracking/{code}` on ameex.ma; the French site uses
`suivi-colis` in place of `tracking`. The site's search markup and its scripts build that
address with the code in upper case.

## Why there is no adapter

The tracker page renders a lookup on the server, with no token or captcha, but it answers every
public code with "No parcel matches this number", its own placeholder included. Ameex's
customer API at `api.ameex.app` has a parcel tracking route, but it takes a merchant account's
`C-Api-Id` and `C-Api-Key`. So Ameex stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
