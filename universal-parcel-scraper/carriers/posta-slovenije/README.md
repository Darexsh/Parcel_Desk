# Pošta Slovenije

Tracks Pošta Slovenije items, its own and those other posts send to Slovenia, through the guest
lookup of its official MojaPošta app.

## How it works

The web tracker on `moja.posta.si/tracking` and the app ask the same service,
`GET https://moja.posta.si/api/v1/parcels/track/?TrackingNumber={number}`. The web tracker sends an
invisible reCAPTCHA token in `X-ReCaptchaResponse`; the app sends none, and the service answers a
client whose User-Agent names the app, `MojaPosta/{version} ({platform})`, without an account,
key, cookie or token. Other clients without a token are refused. The adapter sends the app's
User-Agent and no Content-Type, which the service would read as an empty JSON body and refuse; a
request that fails to reach Pošta Slovenije is sent once more within the budget.

The reply must name the whole requested number. A number the service does not know comes back
as HTTP 404 with a notice naming it, so it is not found; any other 404 is a transport failure. The
service's refusal and block pages are challenges, and other HTTP errors and malformed replies keep
their own failure kinds. Recognition uses the same lookup.

## Numbers

The adapter takes UPU S10 codes with a valid check digit and treats anything else as invalid
without a request. Detection names Pošta Slovenije for the EMS, parcel, registered and
tracked-letter items it issues: `C`, `E`, `L` or `R` first, `SI` last and a passing check digit.
Its tracker follows them abroad with the destination post's scans, as Slovenská pošta's follows
its own. Its other `SI` codes stay with the generic postal carrier, since the issuer of an S10
code does not establish who delivers it, and the low-confidence `posta-slovenije-s10` rule makes
preflight ask Pošta Slovenije about them.

## Notes

Each scan has a code of Pošta Slovenije's own, Slovenian and English wording, a detail line and,
after a failed delivery, the next step. The adapter maps the codes, keeps the code and reads the
English wording, else the Slovenian. A failed pickup whose next step sends the item back to its
sender is an exception, and a delivery after it reaches the sender, so it reads as returned.

Pošta Slovenije's own scans carry UTC instants. A foreign post's events reach it as UPU events
with that post's wall clock, which the service reads as Ljubljana time before labelling it UTC.
Such an event names a foreign office of exchange, or only the postcode of a post office on the
foreign side of the border. The adapter reads its wall clock in that country's zone, or keeps it
without an offset when the country has several zones or the reply does not tell which it is. The
app identity policy in [identity.ts](identity.ts) (`relabelledFrom: 'Europe/Ljubljana'`) lets such
an event take over the row stored under the Ljubljana reading, by wall clock, provider code and
location.

A scan's place is the post office's name; its number, a postcode, is dropped. The pickup point is
the post office an item waits at, or was collected from. The recipient, the signatory, the scan's
note, sender and recipient details, locker and post office addresses and pickup codes are not read.
A reply without scans is read from the item's own heading as a summary.

## Limitations

The service lists no forwarding scans between sorting centres, which some universal providers
relay. The reply has no delivery estimate or weight.

## Links

The tracker moved from `sledenje.posta.si` to the MojaPošta app, whose script reads a number from
`?trackingNumber=` on `moja.posta.si/tracking`.

## Live test

Set `POSTA_SLOVENIJE_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/posta-slovenije/adapter.live.test.ts`.
Optionally set `POSTA_SLOVENIJE_UNKNOWN_NUMBER` to check a number the service does not know.
