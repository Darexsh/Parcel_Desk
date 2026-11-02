# ELTA Hellenic Post

Tracks ELTA Hellenic Post items, ELTA Courier parcels among them, through the anonymous service
behind ELTA's own tracking page.

## How it works

ELTA's [tracking page](https://www.elta.gr/track) posts the codes it looks up as a form, `code[]`
and a language, to `https://www.elta.gr/trackApi`. The adapter sends that one request for one
code and asks for English (`in_lang=2`). No account, cookie, key or browser is needed. A request
that fails to reach ELTA is sent once more within the budget.

The reply must name the whole requested code. A code without history comes back with the notice
"No Tracking History", and only that notice is a missing item. Another notice, an empty reply, a
block page, HTTP errors and malformed replies keep their own failure kinds. Recognition uses the
same lookup.

ELTA Courier is now part of ELTA, and ELTA's tracker answers its parcels from the same records as
ELTA Courier's own tracker on `www.elta-courier.gr`.

## Numbers

ELTA's tracker asks for the item code, which it describes as two Latin letters, nine digits and
two Latin letters, the UPU S10 layout. ELTA Courier's tracker says most of its shipments use the
same layout, and ELTA's adds that some items from Germany carry a twelve-digit code instead. The
adapter takes S10 codes with a valid check digit, from any country, and twelve-digit codes;
anything else is invalid without a request.

A code ending `GR` is ELTA's, but the issuer of an S10 code does not establish who delivers it, so
detection keeps such codes with the generic postal carrier. A low-confidence rule makes preflight
ask ELTA about them. Twelve digits fit several carriers, so no rule claims them.

Mail from abroad reaches ELTA when a caller names it, a provider names it, or a result gives Greece
as the destination of an S10 item. Its tracker follows such items under the sending post's code to
delivery.

## Notes

Scans carry English wording and no code. The adapter maps the wording; "Arrival in" is followed
by the station's name, so it is read by its opening words. Wording the map does not know goes to
the shared wording rules. "Item deposited at ELTA" is the sender handing the item in at a post
office, so the map reads it as accepted where the shared rules would read a delivery. A text
message to the recipient keeps the stage of the scan before it.
Scan clocks are wall times without an offset and are kept as local times.

The pickup point is the station, a post office or a courier agency, named by the scan that made
the item ready for collection, while it waits there or once it was collected there.

## Limitations

The tracker keeps an item's history for a limited time, after which the item answers like an
unknown code. The twelve-digit codes have not been seen with live history.

ELTA Courier's tracker answers `POST /track.php` with a `number` field, in Greek only. It shows
the voucher's creation and the courier's pickup, which ELTA's tracker leaves out, and leaves out
the attempted-delivery notices ELTA's tracker shows. The adapter does not read it.

## Links

ELTA's home page sends a code to `www.elta.gr/track?code={number}` (`/en/track` in English), and
the tracker looks up the code it finds in the address. ELTA Courier's search form sends the number
as `br` to `www.elta-courier.gr/search`. Lookups archived from ELTA's former site carry the code as
`qc` on `/el-gr/tabid/93/`, the Greek-named tracking page and `/en-us/personal/tracktrace.aspx`,
or in the path of `/Personal/TrackTrace/tabid/93/qc/{number}/`.

## Live test

Set `ELTA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/elta/adapter.live.test.ts`.
Optionally set `ELTA_UNKNOWN_NUMBER` to check a code without history.
