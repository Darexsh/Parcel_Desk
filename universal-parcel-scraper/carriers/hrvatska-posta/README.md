# Hrvatska pošta

Tracks Hrvatska pošta items, letters and Paket24 parcels, international mail among them, through
the public page of Hrvatska pošta's own tracker.

## How it works

The tracking forms on `posiljka.posta.hr` and `www.posta.hr` send the number as `barcode` to
`https://posiljka.posta.hr/hr/tracking/trackingdata`, which renders the item's history on the
server. The adapter reads the same page in English, `/en/tracking/trackingdata?barcode=<number>`,
with one GET. No account, cookie, key, CAPTCHA or browser is needed. A request that fails to reach
Hrvatska pošta is sent once more within the budget.

The page must name the whole requested number, under the English label "Item number"; a page in
another language is a schema failure, as its wording and notices are not the ones the adapter
reads. A number without data comes back with a notice instead of scans. On the English page that
notice reads "Invalid barcode format", although the Croatian page words it "Nema podataka za
uneseni prijamni broj pošiljke", no data for the number entered; only that notice is a missing
item. "Invalid shipment number format" is a number the tracker does not accept. The site can
answer a known item with its error page ("Error 404") under HTTP 200 for a while, and some items
with an empty HTTP 500; both stay inconclusive. Block pages, redirects, other notices and HTTP
errors keep their own failure kinds. Recognition uses the same lookup.

English is read because its wording is the more telling: the Croatian page words an outbound
item at the office of exchange as being prepared for dispatch, and anything new in English reaches
the shared wording rules.

## Numbers

The tracker's own script accepts S10 item codes, 3S codes, twelve-digit 2-of-5 barcodes, SSCCs,
MH10 codes starting `J` and `BAT` codes. The adapter takes the same shapes, with a valid check
digit for S10 codes and SSCCs; anything else is invalid without a request. The tracker itself does
not check S10 check digits and answers a mistyped code as having no data.

Detection names Hrvatska pošta for the parcels, EMS, registered and tracked-letter items it
issues: `C`, `E`, `L` or `R` first, `HR` last and a passing check digit. Its tracker follows them
abroad, to delivery or back. Its other `HR` codes stay with the generic postal carrier, as the
issuer of an S10 code does not establish who delivers it, and the low-confidence
`hrvatska-posta-s10` rule makes preflight ask Hrvatska pošta about them. The other shapes fit
several carriers, so no rule claims them.

Mail from abroad reaches Hrvatska pošta when a caller names it, a provider names it, or a result
gives Croatia as the destination of an S10 item. Its tracker follows such items under the sending
post's code to delivery.

## Notes

The page groups the scans under milestones, such as "Delivery at the Post Office", whose clocks
can interleave; the adapter orders them by clock and reads each scan's wording, not its
milestone. Each scan appears in a desktop and a mobile row, and only the desktop row is read. The
scans carry no code. Wording the map does not know goes to the shared wording rules. An item
received abroad after it was sent is in transit, and a delivery once the item is on its way back
is a return.

A Croatian office or parcel locker comes with its five-digit number, a postcode, which is
dropped; the office's or locker's name stays. A facility abroad keeps the name and code the page
shows. Scan clocks carry no offset. A numbered Croatian office's or locker's scan is on Zagreb's
clock. A scan relayed from abroad is on its facility's clock, which the facility's UPU office
code (`GBLALA`) settles when it names a country keeping one civil time; Spain and Portugal, whose
islands keep other clocks, are left out. Other relayed scans, scans without an office and clocks
that summer time makes ambiguous stay local times.

ParcelsApp relays the tracker under the name Croatia Post, with its wall clocks under a UTC
label. The same map stages those scans, an item received abroad after it was sent is in transit
there too, and a facility abroad takes its clock the same way. A scan without an office keeps
its wall clock there too; ParcelsApp's other Croatia Post scans are read on Zagreb's clock.

The pickup point is the post office or parcel locker where the item waits, named by the scan
that made it ready for collection, while it waits there or once it was collected there. The
weight is given in grams and kept in kilograms; an item without a measured weight shows 0 g. The
page's logo of the delivering unit, Paket24 or the post office, is not read.

## Limitations

The tracker keeps an item's history for a limited time, after which the item answers like an
unknown number. The barcode shapes other than S10 codes have not been seen with live history. The page has no estimated delivery date or service name.

## Links

The link opens the Croatian tracking page for the number. Pasted links to the English page or to
`/tracking/trackingdata` without a language are read too, as are archived links to
`/Tracking/Details` and the `broj` parameter of the tracking page on `www.posta.hr`.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Live test

Set `HRVATSKA_POSTA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/hrvatska-posta/adapter.live.test.ts`.
Optionally set `HRVATSKA_POSTA_UNKNOWN_NUMBER` to check a number without data.
