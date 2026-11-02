# Morning Global

Morning Global is a Hong Kong express and postal group that sells MG International Express
and MG International Postal. It collects parcels in Hong Kong, flies them abroad, clears them
through customs and hands them to a delivery partner in the destination country. Tracked
through the lookup its tracker page makes.

## How it works

1. `direct`: a `GET https://www.morninglobal.com/trace-track/?tracking_number={number}`, the
   page the tracker's links open, whose tracking plugin carries the WordPress nonce of its
   lookup in its configuration. Then one `POST https://www.morninglobal.com/wp-admin/admin-ajax.php`
   with `action=mg_tr_lookup`, that nonce, `tracking_number={number}` and the form's empty
   `mg_tr_website` field, as the page's script sends them. No cookie, key or browser is needed.
   The JSON reply has one result per number asked, with a summary and the scans oldest first.
2. `retry`: both requests once more when one fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with a result marked `found: false`, which the page reports as
  not found. A known parcel without scans has no history.
- WordPress answers a nonce it does not accept with HTTP 403 and `-1`, which is inconclusive
  (`nonce_expired`), and an action no plugin registers with HTTP 400 and `0`, a moved lookup.
  The plugin's own refusals carry `success: false` and are inconclusive.
- The result must name the whole number asked. The tracker takes several numbers separated by
  commas; the adapter sends one.
- Recognition makes the same requests.

## Notes

- A scan's location is a country code with the offset of its clock, as `CA (UTC-4)`. The scan's
  date and minute are read with that offset, unless the country keeps one zone whose clock had
  another offset then, and the location keeps the code. Hub and flight scans name no place and
  keep their wall clock in `local_time`.
- Scans carry their status and a description that repeats it; a description that says more is
  added after the status, without a signatory clause or phone numbers. The statuses stage the
  scans. The former tracking API gave each a code; the current reply has none.
- The destination country is the summary's destination when it names a country, else the
  country of the scan that reports the arrival at destination.
- The summary's `reference` is another number of the parcel's, which the tracker shows as
  Reference. The former tracking API called it the foreign courier's waybill, but the archived
  reply of the public sample holds an AliExpress logistics reference there, and no field names
  whose number it is, so there is no hand-off. The signatory, origin, weight, pieces and
  estimate are not kept.

## Limitations

- No delivery partner, and no estimate or weight.

## Numbers

Two layouts were seen on the carrier's own tracker. The older tracker page shows two letters,
nine digits, a two-letter code and a two-digit counter. One example is too little to tell how
the carrier numbered those parcels, so no rule claims that layout and it is a declared gap. The
current tracker shows `BR`, nine digits and `MG`: the UPU S10 form with Madagascar's code, which
Morning Global's waybills fail on the check digit. A low-confidence rule offers Morning Global for
that layout, and recognition asks it. A number of that form that passes the check is detected as
postal, and recognition asks Morning Global about it too. Under Morning Global it stays its
waybill: no destination post is asked about it.
The adapter sends eight to forty letters and digits. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`morninglobal.com/trace-track/?tracking_number={number}` opens the tracker and looks the number
up; the tracker's script reads that parameter, and the older `ydh` parameter too. Archived
lookups use `ydh` on the tracker and on the former `/yundan/status.php` page.

## Testing

`npm run test:carriers:live -- carriers/morning-global`, with `MORNING_GLOBAL_TRACKING_NUMBER`
and optionally `MORNING_GLOBAL_NO_HISTORY_NUMBER` for a parcel the tracker knows without scans
and `MORNING_GLOBAL_UNKNOWN_NUMBER` set outside the repository.
