# SAPX Express

SAPX Express, formerly SAP Express, is PT Satria Antaran Prima's Indonesian courier. It delivers
marketplace orders and business shipments, such as bank cards, across Indonesia. Tracked through
its tracker's result page.

## How it works

1. `direct`: one `GET https://www.sapx.id/id/cek-awb/{number}`. The tracker renders the
   shipment on the server: the number it looked up, the service, origin, destination and
   status, then the events newest first. It needs no cookie, token, CAPTCHA, phone digits or
   browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The search form posts up to twenty numbers to `/id/cek-awb` and renders the same tables; the
  adapter opens the address for one number.
- A number the tracker does not hold gets "Mohon Maaf Nomor Resi Anda Tidak Ditemukan.", which
  is the only missing shipment. A redirect, a 404, a 403, a bot check and a page without the
  table are no answer, and rate limits and other HTTP errors keep their own failure kinds.
- The tracker matches the whole number in any case; a part of a number finds nothing. The page
  must show the number asked.
- Tokopedia booking codes are held with their dash, which number normalization removes, so the
  adapter puts it back after `TKP01`.
- Recognition makes the same request.

## Notes

- Each event has a day, a month and a year, a clock to the minute, a heading and a remark. The
  page names no zone and Indonesia has three, so the clocks stay `local_time`.
- The heading describes and stages an event through [status.ts](status.ts); wording the map does
  not know goes to the shared wording rules. The summary's status only stands in when no event
  has a stage, because it can be cut short.
- A failed or completed run's remark carries a code and a reason, such as `O1 - Pindah`. The
  code is the event's provider code, and a failed run's reason is added to its description. A
  return to the sender carries a delivery's code, so the heading, not the code, stages it.
- The office a heading names, or the one a check-in's remark names, is the event's location.
  The head office and the next hub are no place.
- The delivery heading names whoever took the parcel, and remarks name the courier and the
  receiver and quote the courier, sometimes with a phone number. Only the heading before the
  receiver is kept; remarks, the origin, the destination and the summary's receiver are not.

## Limitations

- No delivery estimate, weight, proof of delivery or instants.
- The tracker drops old shipments, which then get the not-found notice.
- A sender's own reference, such as a bank's twelve-digit card number, opens only on the
  separate `/id/cek-reference` page, which lists the resi behind it with the recipient's name.
  The adapter does not read it.

## Numbers

SAPX resi numbers seen on its own tracker are three letters for the origin branch or client
followed by thirteen or eleven digits; the tracker's own hint starts them with `CGK`. The
tracker also takes Tokopedia booking codes that start with `TKP01-`. Complaints name a
twelve-digit number for a bank card delivery, which is the sender's reference rather than a
resi. Three letters and digits are printed by several other carriers, booking codes belong to
Tokopedia and twelve digits are common, so no rule claims these layouts and recognition is
never asked. A number filed under SAPX reaches the adapter, which takes eight to twenty-four
letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

SAPX's tracker opens one parcel at `www.sapx.id/id/cek-awb/{number}`; the earlier
`sap-express.id` host, which now redirects to `sapx.id`, used the same path and before that
`/layanan/tracking/details/{number}`. The library reads the number from these addresses.

## Testing

`npm run test:carriers:live -- carriers/sapx-express`, with `SAPX_EXPRESS_TRACKING_NUMBER` and
optionally `SAPX_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
