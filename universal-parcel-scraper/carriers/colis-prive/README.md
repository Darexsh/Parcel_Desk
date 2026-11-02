# Colis Privé

French private parcel network (door, relay point, locker), also delivering in
Belgium and Luxembourg. Tracked by parsing
the public "Mon Colis" detail page, which needs the shipment number plus the
recipient's postcode.

## How it works

1. `direct`: one GET of
   `https://colisprive.com/moncolis/pages/DetailColis.aspx?numColis={number}{postcode}&lang=fr`
   with `redirect: 'manual'`. No session, token or JSON feed: the page is
   server-rendered HTML.
   - A 404 or any 3xx is not-found (`ColisPriveTrackingError`): an unknown
     shipment is bounced to the search page instead of answering 404.
   - Other non-2xx statuses throw `UpstreamHttpError`.
2. `parse()` removes `.divDesti` (recipient name and address), requires the
   `.BandeauInfoColis` banner, checks the displayed 12-character number matches
   the credential, then reads the status banner and timeline rows.

## Notes

- The credential is 12 alphanumerics followed by the recipient's postcode:
  five digits in France, four in Belgium, bare or after `B`, or `L` and four
  digits in Luxembourg. Luxembourg's four digits without the `L` are passed on
  but unconfirmed. Colis Privé's own links carry it as one value, and its search form
  asks for the postcode in a separate field. The adapter takes either: the
  postcode at the end of the number, or a bare 12-character number with the
  `postcode` input. A written prefix such as `B-1000` or `LU 1234` becomes the
  letter. The page never opens without the postcode, so a bare number with no
  postcode is `input_required`.
- The postcode is what opens the page, so treat the whole value as a secret:
  never log it, quote it in an issue or put it in a fixture or `numbers.json`.
  The corpus keeps bare 12-character numbers only.
- Yanwen's US last-mile numbers, `YW` with a hub code and twelve digits,
  YWE's numbers, `YWE` and fourteen digits, GOFO's numbers, `GF` or `CI` with a
  country code and thirteen digits, and Cainiao's `CNG` numbers with fourteen
  digits also end in five digits; detection does not read those as a postcode.
- `.divDesti` is removed before any text is read, not filtered afterwards — a
  later selector can forget a filter, not a removal.
- A page for another shipment is a schema error, never a result.
- The timeline prints `DD/MM/YYYY` with no clock, so each scan keeps its day alone in
  `local_time` and the catalog marks its scans as dated by day by design. `dateKey()`
  rejects impossible dates. Same-day events keep page order.
- The status banner can lag the timeline. A banner repeating an older row's wording while the
  newest row says something else gives way to the newest row, as the status and its text.
- Wording only, no status codes. Exception and return phrases are checked before
  delivery ones, because "nous avons tenté de livrer" contains "livrer".
- "subi un retard" maps to `failed_attempt`.
- Rows announcing a confirmed appointment or a relay drop-off end with the
  planned day, which becomes the delivery estimate. It is dropped once the
  parcel is delivered, waiting, held or returned, or a later row passes it.
- Unmatched wording gets no stage; the sync classifies it and records it for
  review.
- `ColisPriveTrackingError` stays a named `NotFoundError` subclass: host sync
  tests and the live suite match on its name, and `error_type` is a Sentry label.

## Rejected approaches

- Accepting the postcode only as a separate input: the combined value is what
  stored parcels and Colis Privé's links hold, so both forms stay accepted.
- Detecting the 12-plus-four-digit form from a typed number: any 16-character
  number ending in four digits would suggest Colis Privé. It arrives through
  Colis Privé's links or a chosen carrier instead.
- Treating the 3xx bounce as a transport failure: it is the provider's stable
  not-found answer.

## Limitations

- The page has no scan location or weight.
- Undocumented HTML; markup changes fail loudly as schema errors.
- Recipient name and address are never read; the offline test asserts it.

## Testing

`npm run test:carriers:live -- testing/frenchDirectCarriers.live.test.ts`
(no env vars) checks a wrong number maps to a clean not-found.
