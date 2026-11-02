# PCP Express

PCP Express, run by PT Yapindo Transportama, carries documents and parcels between its
branches across Indonesia and delivers them to the door. Tracked through the lookup its
tracking results page makes.

## How it works

1. `direct`: one `POST https://www.pcpexpress.com/apps/RequestTracking.php` whose body is the
   AWB as a JSON string, `"{number}"`, as the results page behind the home page's form sends
   it. It needs no cookie, token, phone digits or browser. The JSON reply has the shipment's
   header and its scans, newest first. The one-AWB page `lacak_detailv2.php` embeds the same
   reply in its script.
2. `retry`: the same request once more after a network failure or a hang.

- An unknown number is HTTP 500 with `{"status":false,"msg":"Awb/Refno tidak ditemukan.!"}`,
  which the page reports as not found. The tracker refuses fewer than fourteen characters as
  not an AWB (`AWB tidak valid`), which is invalid input; the adapter asks nothing for them.
  Another refusal, such as a database timeout, is inconclusive. A 404 or a redirect is a moved
  route.
- The shipment and each of its scans must name the AWB asked.
- Recognition makes the same request.

## Notes

- Each scan's `TrackingDate` is a wall clock to the second, with no zone. Indonesia has three
  zones and the reply does not say whether the clock is the branch's or the system's, so scans
  stay `local_time`.
- A scan's description is its status name, such as `ARRIVAL AT DESTINATION`. Its `StatusId` is
  kept as its provider code and stages it; a status id no reply has shown is staged by the
  names the detail page's script reads. The detail page rewords the names in Indonesian and
  leaves some scans out, such as delivery run sheet assignments; the adapter keeps the reply's
  names and every scan.
- An undelivered scan, `SHIPMENT STATUS ON PROCESS / KIRIM ULANG`, adds the reason the courier
  recorded, such as `PENERIMA TIDAK DITEMPAT`.
- A delivery settles the parcel's status whatever its clock, as the results page lists it
  first.
- A scan's location is its town, else its branch.
- The sender's and recipient's names and towns, the receiver who signed, couriers' names and
  the run sheet, manifest and bag numbers in the reply are not kept.
- The tracker also searches references. The adapter only accepts a shipment whose AWB is the
  number asked, so a reference does not track.

## Limitations

- No estimated delivery, weight, or delivery time as an instant.
- No reply with a pickup or shipment entry scan has been seen; those are staged from the names
  the detail page's script reads.

## Numbers

The current AWB has twenty characters: the origin and destination branch codes, a service
letter and digit, the date, a letter and a five-digit counter, as a lookup on the carrier's
tracking page shows. A public complaint quotes two from 2018 and 2019 that end in six digits
instead of a letter and five. Older AWBs on its e-SAPA tracking addresses have a branch code,
twelve digits and sometimes a four-digit piece counter. No rule claims any of them: a handful
of numbers is too little evidence, and the older layout is a branch code followed by a bare
digit run. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`pcpexpress.com/lacak_detailv2.php?awb={number}` opens one AWB on PCP Express's tracking page.
The home page form posts to a results page that lists several AWBs.

## Testing

`npm run test:carriers:live -- carriers/pcp-express`, with `PCP_EXPRESS_TRACKING_NUMBER` and
optionally `PCP_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
