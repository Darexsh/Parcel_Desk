# Poșta Română

Tracks Poșta Română items, its own and those from other posts while they are in Romania, through
the anonymous lookup behind Poșta Română's Android app.

## How it works

The app posts the number as a form field, `awb`, to `https://api.posta-romana.ro/api/track-trace`.
The adapter sends that one request. No account, cookie, key or browser is needed. A request that
fails to reach Poșta Română is sent once more within the budget.

The reply is JSON labelled as HTML. It must name the whole requested number. An unknown number
comes back with `found` false, which the app explains as not yet registered; the same flag with
`trimitereSimpla` marks unregistered mail, which has no history and stays inconclusive. A refusal,
a browser check, HTTP errors and malformed replies keep their own failure kinds. Recognition uses
the same lookup.

The tracker on `www.posta-romana.ro` asks for a Turnstile check before its own lookup, so the
adapter does not use it.

## Numbers

The tracker takes S10 item codes, two letters, nine digits and two letters, and answers domestic
parcels numbered with two letters and eleven digits as well. The adapter takes S10 codes with a
valid check digit, from any country, and that domestic shape; anything else is invalid without a
request.

A code ending `RO` is Poșta Română's, but the issuer of an S10 code does not establish who
delivers it, so detection keeps such codes with the generic postal carrier. A low-confidence rule
makes preflight ask Poșta Română about them. The domestic shape is shared with other carriers, so
no rule claims it. Mail from abroad reaches Poșta Română when a caller names it, a provider
names it, or a result gives Romania as the destination of an S10 item.

## Notes

The tracker shows only scans in Romania: an item sent abroad ends with its dispatch from the
international exchange office, and mail from abroad starts with its arrival there. Scan clocks are
Romanian wall times, read on Bucharest's clock; the hour the clocks repeat reads as its first
occurrence.

Scans carry Romanian wording without diacritics and no code. The adapter maps the wording, also
when it is written with diacritics, and passes the rest to the shared wording rules. A site after
"Plecat din" is the one the item left. Once an item moved, "Primit de la expeditor" is its
sender's post taking it back, and a delivery after "Returnat catre expeditor" reaches the sender.

The pickup point is the office named by the scan that scheduled the item for collection, while it
waits there or once it was collected there. The service name comes from the reply's summary. The
summary's posting office and date, the country of origin of mail from abroad and the office's
opening hours are not kept.

## Limitations

The API refuses some networks with HTTP 403, which the adapter reports as a refusal. The website
words an unknown number's reply as the item not yet registered or the system possibly being down,
so an outage that answers this way reads as not found. The tracker accepts the codes some posts use
instead of S10, such as the Dutch `3S` codes and twelve-digit codes from Germany, which the adapter
does not take.

## Links

The tracker reads the number from `awb` on `www.posta-romana.ro/track-trace.html` and requests its
status.

## Testing

Set `POSTA_ROMANA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/posta-romana/adapter.live.test.ts` from a network the API
accepts. Optionally set `POSTA_ROMANA_INBOUND_NUMBER` to check mail from abroad and
`POSTA_ROMANA_UNKNOWN_NUMBER` to check a code the tracker does not know.
