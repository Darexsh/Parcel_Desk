# Team Express

Team Express Services is a Dubai courier for domestic and export shipments. Tracked through its
tracking page.

## How it works

1. `direct`: one `GET https://teamexpressme.com/tracking?trackno={number}`, where the page's
   tracking form sends a visitor. The page renders the shipment on the server: its airwaybill,
   service, origin, destination and current status, then the scans newest first. It needs no
   cookie, token, CAPTCHA, phone digits or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The shipment must show the airwaybill asked. A shipment for another number is no answer, and
  neither are two for the same one.
- A number the tracker does not hold, unknown or expired, gets the form alone without a notice.
  A failing record store could leave the same page, so it is inconclusive rather than not found.
- A redirect, a 404, a 403, a bot check and a page without the tracking form are no answer, and
  rate limits and other HTTP errors keep their own failure kinds.
- No recognition: the tracker never says that it does not know a number.

## Notes

- Each scan has a date, a 12-hour clock, a location, a status and its details. The page names
  no zone and an export ends abroad, so the clocks stay `local_time`.
- The details stage a scan before the status they are filed under, through
  [status.ts](status.ts): the tracker files an export's first scan at its own center under
  "In Transit", and other scans under "OTHERS". That center's scans give the company's name as
  their location, which is left out.
- An export's scans stop when it is handed to the partner abroad. Its delivery shows only as
  the current status, which then gives the stage.
- An export can show the partner's forwarding number beside a "View Details" link to the
  partner's tracker. The page names the partner no other way, so the partner and its number are
  reported when the link belongs to one catalog carrier and the number has that carrier's
  shape. The link is never followed.
- The shipper's reference number, the ship date, who signed and the delivery date are not
  kept. The delivery date is a wall clock, the partner's for an export.
- Team Express's other site, teamex.ae, posts the number to its own tracking page, which runs
  the same vendor's tracking plugin.

## Limitations

- No delivery estimate, weight, proof of delivery or instants.
- Expired shipments get the same empty form as unknown numbers.
- Only the two airwaybill layouts below are taken.

## Numbers

Archived lookups on Team Express's tracker show airwaybills of the letters `SMART` and seven
digits. A customer's review gives one of `RAKPOS` and eight digits, a bank's domestic delivery,
which the tracker shows. The prefix seems to follow the client, and the tracker comes from a
software vendor whose tracking plugin also runs on other Dubai courier sites, so no rule claims
either layout and the gaps are declared. A number filed under Team Express reaches the adapter,
which takes these two layouts. The samples and their sources are in
[`numbers.json`](numbers.json).

An export handed to a partner abroad also shows that partner's forwarding number, which is not
a Team Express number.

## Links

The tracking form sends the number as `trackno` to `teamexpressme.com/tracking`, so
`teamexpressme.com/tracking?trackno={number}` opens one parcel. Archived lookups use the same
address.

## Testing

`npm run test:carriers:live -- carriers/team-express-ae`, with `TEAM_EXPRESS_AE_TRACKING_NUMBER`
and optionally `TEAM_EXPRESS_AE_UNKNOWN_NUMBER` set outside the repository.
