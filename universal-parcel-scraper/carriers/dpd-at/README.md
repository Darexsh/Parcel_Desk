# DPD Austria

DPD Austria is DPDgroup's network in Austria. Tracked through the lookup of its own tracker,
myDPD on `mydpd.at`, which also knows the parcels other DPD networks send it to deliver in
Austria.

## How it works

1. `direct`: one `POST https://www.mydpd.at/jws.php/parcel/search` with the fourteen-digit
   number as a JSON string, as the myDPD page sends it. It needs no cookie, token, key or
   browser. The JSON reply lists the parcel with its scans, oldest first.

- An unknown number is HTTP 200 with `{"state":"failure"}`, which the page reports as not
  found. A failure carrying a message for the page to show is inconclusive.
- Radware's bot manager guards the site. An address it distrusts gets Radware's own page with
  HTTP 200 instead of the reply, or a redirect to its captcha, and the adapter reports both as
  a challenge. HTTP 429 is the page's limit on attempts.
- DPD's check character after the number is dropped. One that does not match is a typo, not
  another parcel.
- The parcel must carry the number asked.
- Recognition makes the same request. It knows a parcel only when the newest scan is in
  Austria, and a newest scan without a country is inconclusive. DPD Austria comes first for its
  depots' numbers, so a parcel that has moved on to another country is left to that country's
  DPD network.

## Notes

- DPD's group guest API, which the other `dpd-*` adapters read, gives a parcel looked up
  without its postcode as milestones without places, and no longer knows older Austrian
  parcels that myDPD still has. myDPD gives every scan with its depot, so the adapter reads
  myDPD and shares no code with the group adapters.
- The page asks for the delivery postcode only to show the sender, the recipient, the delivery
  window and the redirection options. The scans come without it, and the adapter sends none.
- Each scan's `datetime` is a wall clock without a zone. For Austrian and German scans it
  matches the group tracker's instants read in Vienna's time. A scan in a country whose clock
  agrees with Vienna's at that moment is read in Vienna; any other keeps its wall clock in
  `local_time`. The reply names a depot's town and country on the first scan there only; the
  depot's later scans keep them, and a depot no scan names is placed by DPD Austria's depot
  list.
- A scan's description is its state's text. The state's name (`NAB`) is the provider code and
  stages it, with the qualifier the page uses for a Pickup station or the recipient's chosen
  place after a slash (`HANDOVER/BOX`). A driver's collection from a Pickup parcelshop
  (`DRIVER_PICKUP/SHOP`) is the sender's drop-off collected, an acceptance or a hand-over in
  transit; after the parcel waited at a Pickup point for its recipient it starts the way back.
- Once the postcode is verified, the page adds details to some scans: the Pickup shop, who
  took the parcel, where it was left. The adapter reads none of them, nor the sender and
  recipient fields, which are empty without the postcode.

## Limitations

- No weight, no delivery estimate and no Pickup point.
- An address Radware distrusts stays challenged for a while; the adapter does not solve the
  captcha.

## Numbers

Parcels carry DPD's fourteen-digit parcel number, whose first four digits are the issuing
depot. DPD Austria's depot list gives its depots the codes 0620 to 0630, 0632 to 0635, 0643 to
0645 and 0649, and both myDPD and archived replies of DPD's group tracker show parcels with
those codes scanned at Austrian depots. `dpd-at-1` claims fourteen digits starting with one of
those codes at low confidence and lists DPD Austria first, as DPD Switzerland's rule does for
its own depot codes. Recognition asks DPD Austria first; the DPD networks it asks after need
the guest API to place the parcel in their own country. Other fourteen-digit numbers stay with
the other DPD entries' low rules.

The parcels other networks send DPD Austria keep their own depots' codes, which no DPD Austria
rule claims; filed under DPD Austria, they are tracked through myDPD. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

DPD Austria's page on `dpd.com` builds `www.mydpd.at/?f=parcel.load&p={number}`, which opens
one parcel. Archived lookups also use `mydpd.at/meine-pakete?ipn={number}`. Both are read for
DPD Austria.

## Testing

`npm run test:carriers:live -- carriers/dpd-at`, with `DPD_AT_TRACKING_NUMBER` and optionally
`DPD_AT_UNKNOWN_NUMBER` set outside the repository.
