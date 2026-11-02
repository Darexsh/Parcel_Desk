# South African Post Office

Tracks South African Post Office items, its own and the S10 items of other posts, through the
lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://trackingnew.postoffice.co.za/?ParcelId={number}`, as the page's
   form sends it. It needs no account, cookie, token, key or browser. The page is rendered on the
   server, with no API behind it.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The page's `No tracking record found` notice is not found. The form with no notice, or with
  another one, is inconclusive. A 403 or a firewall page is a challenge. A 404 or a redirect is a
  moved route.
- The page must echo the whole requested code. Recognition makes the same request.

## Notes

- Each scan has a broad type and a comment. The comment is the scan's wording: the adapter maps
  it, passes unknown wording to the shared rules and stages a scan neither knows by its type. A
  scanner's `COMMENT` note has no stage.
- A delivery's comment and the page's summary name the person who collected the item. The
  adapter drops the name, and phone numbers in any comment. It reads only the item number from
  the summary.
- A scan's date and time are the office's wall clock to the minute, with no zone. Every scan is
  the Post Office's own, made in South Africa, which keeps one civil time all year, so the adapter
  reads them on South Africa's clock. Royal Mail's tracker and ParcelsApp give an item's scans in
  South Africa the same instants. The newest scan is the last update, and a delivered item's
  delivery scan its delivery time.
- The office that sent the notice to collect the item is its pickup point, and stays so for an
  item collected there.
- The page lists some scans twice; the adapter keeps them once.
- The tracker holds only the Post Office's own scans: mail from abroad shows from its arrival at
  the international mail centre, and mail sent abroad until its dispatch.

## Limitations

- The page has no ETA, weight, service, origin or destination.
- Older items drop out of the tracker's records and then read as not found.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

The Post Office numbers its items in the UPU S10 layout ending `ZA`, domestic parcels included.
Inbound items keep the number of the post that accepted them. The adapter takes S10 codes from any
post with a valid check digit; anything else is invalid without a request.

A code ending `ZA` is the Post Office's, but the issuer of an S10 code does not establish who
delivers it, so detection keeps such codes with the generic postal carrier.
`south-african-post-office-s10`, at low confidence, makes preflight ask the Post Office about
them. Mail from abroad reaches the Post Office when a caller names it, a provider names it, or a
result gives South Africa as the destination of an S10 item. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking form on `trackingnew.postoffice.co.za` sends the number as `ParcelId` to the same
page, so `trackingnew.postoffice.co.za/?ParcelId={number}` opens one parcel. The earlier
tracker on `tracking.postoffice.co.za` read it from `id` on `/TrackNTrace/TrackNTrace.aspx`.

## Testing

`npm run test:carriers:live -- carriers/south-african-post-office`, with
`SOUTH_AFRICAN_POST_OFFICE_TRACKING_NUMBER` set outside the repository. Optionally set
`SOUTH_AFRICAN_POST_OFFICE_INBOUND_NUMBER` to check mail from abroad and
`SOUTH_AFRICAN_POST_OFFICE_UNKNOWN_NUMBER` to check a code the tracker does not know.
