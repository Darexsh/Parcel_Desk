# DSV

Tracks DSV shipments through the public track and trace of myDSV, the page at
`mydsv.com/track-shipment`, and former DB Schenker road shipments through DSV's separate
tracker for them.

## How it works

The page asks three JSON services on `mydsv.com`, and the adapter does the same with plain HTTP,
without an account, key or cookie:

1. `GET /app/search/publicShipmentList?q={number}` lists the shipments whose shipment, booking,
   quote, house bill, master bill, waybill or carrier tracking id matches the number. Each comes
   with its ids, mode of transport and a key that opens its details.
2. `GET /app/search/shipment/{key}?detailedMilestones=true` holds the shipment's details. The
   adapter asks for them only to read the house bill number when the search matched none of the
   shipment's own ids.
3. `GET /app/search/shipment/new-statuses/{key}` holds the history the page's Track & Trace tab
   shows.

A lookup that fails to reach myDSV is sent once more within the budget. HTTP errors, block
pages and malformed replies keep their own failure kinds; a missing route is a transport failure.

## Former DB Schenker shipments

DSV tracks former DB Schenker shipments on a separate tracker, `www.dsv.com/mydsv/tracking-public`,
which `dbschenker.com` redirects to. When myDSV's search does not know an STT (three letters and
seven or eight digits, or five letters and nine digits) or a package's SSCC, the adapter asks that
tracker's API under `www.dsv.com/nges-portal/api/public/tracking-public/`:

1. `GET /shipments/land/LandStt:{STT}:LAND` holds a road shipment's details and history. The
   page puts the data sources its search names into the id; without them the tracker adds them
   itself, so an STT needs no search.
2. A package's SSCC goes through `GET /shipments?query={number}` first, which lists the shipments
   whose STT, package, waybill or a reference matches the number, each with its mode of transport
   and id. The details take no package id.

The API answers every request with HTTP 429 and a `Captcha-Puzzle` header: base64 of signed
tokens, each holding a 64-byte puzzle. For each, the client finds the eight-byte little-endian
nonce whose double SHA-256 after the puzzle's first 32 bytes, read little-endian, is under the
target that bytes 13 and 14 set as exponent and mantissa. It repeats the request with
`Captcha-Solution`, base64 of the tokens and their nonces. A puzzle takes a few thousand hashes,
milliseconds in Node; one that asks for far more is left inconclusive, and solving stops when the
budget ends. The official DSV Tracking app (`com.dbschenker.mobile.connect2schenker`) calls the
same API on `mydsv.dsv.com`, without a key or an account, and solves the same puzzle. The page's
other public base, `/nges-portal/api/public/tracking/v1`, sets it too, and myDSV's search does
not know former DB Schenker STTs, so no public read confirms an STT without the puzzle.

The tracker answers within a second, but at times holds each reply for a quarter or half a
minute. The step waits as long as an STT's details, or an SSCC's search and details, take then,
or less when the lookup has less time left, and gives up after that, so the universal providers
after it keep theirs.

The shipment belongs to the number when the details name it as one of the shipment's own ids:
its STT, the STT it was booked under, or a package's SSCC, with or without the 00 before it.
A waybill or a party's reference is left inconclusive, and so are several shipments for one
number and air and ocean shipments. A number neither tracker knows stays inconclusive.

Each row keeps its event code, its English wording with the reasons the page shows, and its
place without postcodes. The reply gives most clocks an offset and labels some local clocks Z;
the page prints each clock as written, and the adapter keeps them as wall clocks. The agreed
delivery day, else the estimated one, is the delivery estimate until the shipment is delivered.
The parties, references, addresses, goods, the recipient on a delivery and the packages' own rows
are not read.

## Recognition

Recognition asks the former DB Schenker tracker about an STT straight away, puzzle included, as
myDSV's search does not know them; any other number takes the ordinary lookup. It waits three
seconds at most. A later answer, and a number neither tracker knows, leave DSV offered by its
detection rule alone.

## Notes

The shipment belongs to the number when the search names it as one of the shipment's own ids:
its shipment id, booking id or main transport id, or, from the details, its house bill. A match
on anything else, such as a master bill or a partner's tracking id, can belong to another
carrier's consignment and is left inconclusive, and so are several shipments for one number.
An empty search sends an STT or a package's SSCC to the former DB Schenker tracker.

The history comes in milestone groups: the booking, the pickup or receipt, the departures and
arrivals of the main carriage, and the handover. When the reply has port data, the adapter reads
the groups before and after the main carriage and each port's own departures and arrivals, as the
page lists them. Earlier values of a row are kept out of the history, except for XPRESS
shipments, whose page lists them as rows. Each row keeps DSV's date type as its code, its
English wording and its place, without postcodes. Estimated and requested dates are not scans
and are left out; the estimated delivery is the delivery estimate until the shipment is
delivered. "Handover responsibility of cargo" (`Z70`) ends DSV's service and completes the
shipment.

Clocks are the wall clocks of each place, without an offset, so they stay local. A booking comes
with its day alone.

The parties, their towns and postcodes, the references, contacts, proofs of delivery and the
shipment key are not read.

## Limitations

The search takes the number as typed, and the tracker passes it without dashes, so a shipment id
that DSV prints with a dash is not found. The page also asks a real-time tracking service for
XPRESS shipments; the adapter does not. A road shipment's history can hold only its booking.

Detection offers DSV, with low confidence, for a former DB Schenker STT of five letters and nine
digits whose first two letters are a European country code, the layout DB Schenker's own tracking
links name an STT. The shorter STTs share their layout with other carriers, and a package's SSCC
carries the GS1 company prefix of whoever issued it, usually the shipper, so the user picks DSV
for them. A link names DSV whatever the number: myDSV's search with `query`, and the former DB
Schenker tracker with `refNumber`, as DSV's header form and Self-services open it on
`www.dsv.com/mydsv/tracking-public` and `mydsv.dsv.com/app/tracking-public`.

A former DB Schenker lookup runs out of time when the tracker holds its replies longer than the
lookup has left, and on its slower servers. A package SSCC that the tracker lists under several
shipments stays inconclusive, and other numbers, such as a waybill, are not sent to that tracker.

## Testing

Set `DSV_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/dsv/adapter.live.test.ts`.
Set `DSV_SCHENKER_NUMBER` to a former DB Schenker STT or package SSCC to check that tracker, and
optionally `DSV_UNKNOWN_NUMBER` to an STT neither tracker knows.
