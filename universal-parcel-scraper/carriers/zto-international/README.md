# ZTO International

ZTO International (中通国际) is ZTO Express's cross-border arm. It takes parcels bought abroad
from its warehouses in the United States, Japan, Korea and Hong Kong through Chinese customs to
ZTO's domestic network, and carries exports from Guangzhou to its own networks in Southeast Asia.
Tracked through the lookup its mobile tracking page makes.

## How it works

1. `direct`: one `POST https://taurus-api.ztoglobal.com/applet/track/queryFromMainSite` with the
   body the page on `m.ztoglobal.com` sends,
   `{"data":{"data":["{number}"],"uuid":"","verificationCode":""},"timestamp":…,"version":"3.78.0","countryCode":"LA"}`.
   It needs no cookie, token, key or browser. The JSON reply has one entry per waybill found,
   with its number and its scans, newest first. A request that fails to reach the service gets
   one more try.

- An unknown number, an empty request and a number the service cannot read all get HTTP 200
  with `{"success":true}` alone, so that reply is inconclusive (`portal_not_found`) rather than
  not found.
- A refusal with code 19001 or 19002, which the page answers by asking for an image code, is a
  challenge. So are 50003 and 60005, the image-code errors of the search page's lookup. The
  adapter does not solve them.
- The waybill and each of its scans must name the number asked.
- Recognition makes the same request.

## Notes

- The page signs its body with a key from its bundle. The service does not check the
  signature, so the adapter sends none.
- The phone search page on `intlapp.ztoglobal.com` asks for an image code before every lookup,
  and the desktop tracker on `www.ztoglobal.com` for a slider. The tracking page's own lookup
  asks for neither.
- Each scan's `time` is a wall clock with no zone, kept in `local_time`. ZTO dates every scan on
  Shanghai's clock, abroad too, so each is read on it. Read on Berlin's clock, the scans of a
  station in Germany came after the lookup that returned them; on Shanghai's, each falls at the
  minute of 17TRACK's copy. [`identity.ts`](identity.ts) lets a scan take over the row an app
  stored for its wall clock under another offset, with the same place, wording and code.
- A scan's description is its English line without the place in brackets that opens it; a
  scan without English keeps its Chinese line. Both lose the clauses naming a courier, scanner,
  picker, signer, operator, collection point, bag or phone. The place is the station a delivery
  was signed at, else the first bracket of the Chinese line: a station, warehouse, city or
  country.
- Code 16's English line says Delivered, but its Chinese line has a parcel station or someone
  else taking the parcel in for the recipient, and the collection follows as code 15. The
  adapter words it "Received on the recipient's behalf" and stages it ready for pickup.
- The `status` code stages each scan. A code the map does not know is staged by its wording
  when the shared rules read it.
- The tracker also finds a waybill under the number of its first leg (`startNo`) and answers
  with the waybill. The adapter asks only for waybill numbers, so an answer under another
  number is another waybill and the lookup is inconclusive.

## Limitations

- No ETA, weight, service, sender, recipient or proof of delivery.
- A waybill the tracker does not know cannot be told apart from a request it could not read.

## Numbers

ZTO's own configuration gives its international waybills 771 and eleven digits. Domestic ZTO,
DPD and other carriers issue fourteen-digit numbers of the same shape, so `zto-international-1`
is a low-confidence rule that lists ZTO International first, and recognition asks it first. The
samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`npm run test:carriers:live -- carriers/zto-international`, with
`ZTO_INTERNATIONAL_TRACKING_NUMBER` and optionally `ZTO_INTERNATIONAL_UNKNOWN_NUMBER` set
outside the repository.
