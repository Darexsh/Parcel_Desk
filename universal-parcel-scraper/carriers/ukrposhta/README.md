# Ukrposhta

Tracks domestic barcodes and international postal references through Ukrposhta's
status API and the official consumer tracker, including the destination post's
scans when it supplies them. Detection offers a 13-digit barcode only when its
last digit passes the mod 11 check (weights 2 to 7 from the right); other
carriers share that length, so it stays a suggestion. Ukrposhta's tracker relays
the foreign post's scans for the parcels, EMS, letter and registered items it
sends abroad, so detection names it for
[UPU S10](https://www.upu.int/UPU/media/upu/files/postalSolutions/programmesAndServices/standards/S10-12.pdf)
codes ending UA that start C, E, L or R, as for the neighbouring posts. For the
other UA codes the suffix names the issuing country, not the deliverer: they stay
with the generic postal carrier and recognition asks Ukrposhta first.

## How it works

`direct` asks the status API that Ukrposhta's Android app uses, over plain HTTP.
The app's shared application bearer is included; consumers need no key setup.
The reply is a list of scans, each naming its barcode and its position in the
history. Every row must name the requested barcode.

`browser` is the fallback. A fresh anonymous browser submits the same reference
twice through the native batch form. That response supplies an exact barcode, the
current scan and a history count. A single-reference query then supplies full
history. The adapter requires the count and current scan to agree across both
replies before accepting history. The browser completes the portal's automatic
verification; interactive challenges remain failures. No account, saved browser
profile or recipient details are used.

## Mobile app

The endpoint comes from the Android app `ua.ukrposhta.android.app`:
`GET https://www.ukrposhta.ua/status-tracking/0.0.1/statuses` with `barcode` and
`lang`, and an `Authorization: Bearer` header carrying one credential shared by
every install. A request without it, or with one Ukrposhta has retired, gets an
HTML refusal. The adapter treats that as a challenge and the browser takes over.

The newer Flutter app `ua.ukrposhta.ukrposhta` tracks through account routes on
`my.ukrposhta.ua` and offers no guest lookup.

## Notes

The status API orders scans by position and its clocks include seconds. On the
portal the batch clock includes seconds, while full history has minute precision;
matching uses that shared precision. Clocks carry no offset. A row naming Ukraine
is dated on Kyiv time (`Europe/Kyiv`) to the shared minute, so both sources date
a scan alike. Rows naming another country or none, such as airline legs, and wall
clocks a daylight-saving change skips or repeats keep their local digits. The status
API names an office of exchange, and an airport or another post's scan abroad,
`TERMINAL`; that is a kind of facility, so the place is the row's country. Scans
retain native order. See [ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md)
for unresolved history handling. A return decision starts a separate leg; later
transport remains active until a delivery scan completes that leg.
The parcel app's review (`statusMap`) answers a stored scan by its code, and a
delivery worded as a return as returned. It cannot see a scan's reason code, which
can make it an exception, or the return leg of a delivery worded as a delivery.

Both sources read the same domestic records. When the status API does not know a
domestic barcode the browser is not asked. An international reference still gets
the portal, which also shows the destination post's scans.

A postal item from abroad bound for Ukraine is also looked up at Ukrposhta when
the sending carrier names no delivery partner; the host decides whether to adopt
the answer. The status API misses some of that mail, and can say an item has no
tracking service when the portal shows its journey, so such a lookup can start
the browser. A lookup takes at most a minute.

Recognition asks the status API alone, over plain HTTP. Its not-found reply makes
a domestic barcode unknown to Ukrposhta; for an international reference the check
stays unanswered, since the portal is not asked.

## Limitations

Detection only suggests Ukrposhta, for a thirteen-digit domestic barcode, a length
other carriers share, and for a postal number it issued.
The fallback needs `TRACKING_CHROMIUM_PATH`. Neither
not-found reply names the barcode, so tracking reports neither as parcel absence:
each stays inconclusive, with the reason `status_api_not_found`, or
`portal_not_found` when the portal, asked last, misses it too. On the
portal, multiple-piece shipments, count changes between requests and conflicting
current scans are inconclusive. Delivery and estimate dates are not inferred from
local scan clocks or the query time; only a delivery scan dated on Kyiv time dates
the delivery. The portal can refuse the browser's automatic
verification. The lookup then fails as a challenge and routing falls back to the
universal providers.

## Testing

Run `npm run test:carriers:live -- carriers/ukrposhta`. `UKRPOSHTA_TRACKING_NUMBER`
adds a positive lookup and `TRACKING_CHROMIUM_PATH` the browser checks; supply both
outside the repository.
