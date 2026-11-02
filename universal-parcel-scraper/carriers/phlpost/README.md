# PHLPost

Tracks the Philippine Postal Corporation's items, its own and the S10 items other posts send to
the Philippines, through the lookup its tracking page at tracking.phlpost.gov.ph makes.

## How it works

1. `direct`: one `POST https://tracking.phlpost.gov.ph/Home/GetTrackingEventsJson` with the
   JSON body `{"TrackingNumber": "<code>"}`, as the page sends it when someone opens an item's
   history. It needs no account, cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The reply is an array of rows, each naming the item code. Every row must name the whole
  requested code. A code the tracker does not know comes back as a single "Not Found" row
  without a date, which is not found. An empty array, or a "Not Found" row anywhere else, is not.
- A 429 is a rate limit, a 403 or a bot check a challenge, and a redirect or a 404 a moved route.
  Recognition makes the same request.

## Notes

- The tracker joins two systems. IPS, the UPU's system, gives the scans of PHLPost's offices and
  of the posts abroad, each with the country of the office and its wall clock to the second. The
  domestic delivery system gives PHLPost's own delivery scans without a place and to the minute.
  The page lists the domestic rows first; the adapter orders all rows newest first by clock.
- Both clocks are the office's. A scan in the Philippines, which every domestic row is, reads on
  Manila time: PHLPost's scans fall in its office hours that way. A scan abroad, or in a country
  the row does not name in full, keeps its wall clock. The reply's `EventDate` is the same wall
  clock read as Manila time by the server, so it settles nothing abroad and is not read.
- Both systems number their events, and the numbers collide: code 3 is an arrival at the
  outward office of exchange and an import of customs data, and the domestic system's 8 and 30
  are not IPS's. The wording sets the stage.
- IPS names countries in ISO's style, "United States of America (the)", and cuts them at
  50 characters. The adapter drops the article; a cut name stays as it is, without a country.
- The country of IPS's arrival in the country of destination becomes the destination, else the
  Philippines when the domestic system sends the item to a delivery office or delivers it.
- Deliveries name who received the item and how they relate to the addressee. The adapter keeps
  only "Item delivered".
- One of the tracker's two addresses accepts no connection. Clients that try both addresses,
  such as Node's fetch, connect at once; one that waits on the dead address times out.

## Limitations

- The tracker has no ETA, weight, service or sender.
- An item sent back to its sender shows ordinary outward IPS scans and reads as in transit.
- Inbound registered small packets from China were not found on the tracker, while EMS from
  abroad was. Older items drop out of its records unevenly and then read as not found.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

PHLPost prints UPU S10 numbers ending in `PH`: registered letters, EMS, parcels and others. The
issuer of an S10 code does not establish who delivers it, so detection keeps such codes with the
generic postal carrier. `phlpost-s10`, at low confidence, makes preflight ask PHLPost about them.
Mail from abroad keeps the suffix of the post that issued it, and reaches PHLPost when a caller
names it, a provider names it, or a result gives the Philippines as the destination of an S10
item. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker takes up to 30 numbers, one per line, and loads their histories with a POST
request. Lookups saved from it carry the numbers in the `TrackingNos` parameter, and the library
reads a number from that address, but opening it shows only the empty form, so no address opens
one parcel.

## Testing

`npm run test:carriers:live -- carriers/phlpost`, with `PHLPOST_TRACKING_NUMBER` set outside the
repository. Optionally set `PHLPOST_INBOUND_NUMBER` to check mail from abroad delivered in the
Philippines and `PHLPOST_UNKNOWN_NUMBER` to check a code the tracker does not know.
