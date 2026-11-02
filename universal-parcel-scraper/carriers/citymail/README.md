# CityMail

CityMail delivers parcels and mail for online shops in Sweden, to the door, the letterbox or
a service point. Tracked through the tracker its Spåra paket page sends the reference to.

## How it works

1. `direct`: one `GET https://tracking.citymail.se/?search={reference}`. The Spåra paket form
   on citymail.se answers with a redirect to that address. No cookie, token, key or browser is
   needed. The HTML page has the current status, the sender, the product code, the reference
   the parcel was booked under, an estimated delivery day while one is set, and the scans,
   newest first.
2. `retry`: when CityMail cannot be reached or hangs, the read is sent once more. The first
   try gets half of the budget.

- A reference the tracker has nothing for is HTTP 200 with a notice naming it, which is not
  found. A redirect, a 404 or a page with neither is not.
- The search box must echo the reference asked, and the page's original reference
  (`Ursprunglig paketreferens`) must be that reference.
- Recognition makes the same request.

## Notes

- Scan clocks are shown to the minute without a zone. CityMail works in Sweden only, so they
  are read as Stockholm time.
- The scans carry no code; their wordings are mapped. Any other wording goes to the shared
  wording rules. The icon beside the current status is not read.
- A delivery scan's place is the recipient's postcode and town. The postcode is dropped and
  the town kept. The page's delivery photo is not kept either.
- The place of the scan that leaves a parcel at a service point (`ombud`) is the point's
  name. It is the result's `pickup_point` while the parcel waits there, and after it is
  collected.
- `Produktkod` (`PRIO`, `BAS`, `Ombud`) is kept as the service name and `Avsändare` as the
  sender.
- The page names no other carrier or number, so there is no hand-off.

## Limitations

- The tracker drops a parcel some months after its last scan, and then answers not found.
- No weight, provider codes or offsets.

## Numbers

CityMail's tracker asks for the parcel reference from its SMS or email. Lookups archived from
its tracker show references of `BCM`, one to three letters and seven to nine digits; the
letters after `BCM` change with the sender, and the Spåra paket page's own example has the
same layout. `citymail-1` claims that family at high confidence, so recognition is not needed
to settle it. Its twelve-character references also fit the GoGo Xpress and Colis Privé
twelve-character rules, which is declared. CityMail's integration document has a sender build
the reference from a prefix CityMail gives it and an identifier of its own. Some senders'
references are `BCM`, two letters, thirteen digits and `CN`; the tracker answers them with
CityMail's own scans, and `citymail-2` claims that layout at high confidence too.

Amazon parcels CityMail delivers keep Amazon's `AM` and nine-digit reference, a shape other
carriers' references share, so no rule claims it; the adapter still tracks it when CityMail is
chosen. Archived lookups of S10 numbers and of a sequential `UN` series found nothing on
CityMail's tracker, so they are not kept. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker on `tracking.citymail.se` is a GET form that sends the reference as `search`, so
`tracking.citymail.se/?search={number}` opens one parcel; archived lookups use the same
address. The Spåra paket page on `citymail.se` posts the number to the site, which redirects
to that address.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Testing

`npm run test:carriers:live -- carriers/citymail`, with `CITYMAIL_TRACKING_NUMBER` and
optionally `CITYMAIL_UNKNOWN_NUMBER` set outside the repository.
