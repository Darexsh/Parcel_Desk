# DAI Post

Tracks DAI Post, the cross-border network that delivers parcels from overseas shippers in
Australia and New Zealand, and some in Singapore, through its public tracking page, without
an account, a key or a browser. ePost Global and Asendia hand parcels over to it.

Parcel Right is DAI Post's Australian delivery brand: its tracker on parcelright.com.au shows the
same parcels from the same service, so its name and links, including the parcelrig.ht short
links Passport hands out, open DAI Post.

## How it works

1. `direct`: `GET https://daipost.com/track?tracknbr={number}` with the header `RSC: 1`.
   The Next.js page answers with its React Server Components rows (`text/x-component`)
   instead of HTML. The page row holds the tracking view's `trackingresponse`, one entry
   per number asked, with its scans and its delivery estimate. An unknown number gets the
   heading "Sorry, we couldn't find your parcel." and the page's search field filled with it
   instead: not found, after one request.
2. `retry`: one more try after a request that did not reach the site or hung; the first
   gets half of the budget.

Recognition uses the same lookup.

## Notes

- Text rows give their length in bytes and end without a line feed, so the next row often
  follows on the same line. Rows are read by that length, not split at line feeds.
- The entry's `tracknbr` must be the whole requested number, and the absence heading needs
  the search field to hold it. Every page also carries the layout's generic "Sorry, this
  page cannot be found." template, which says nothing about the number. A found entry
  without scans has no history yet: the page says the parcel was not dropped off yet or its
  history, older than 180 days, was archived.
- An HTML reply is a page served instead of tracking data, and a challenge. A 404 or 410
  means the page moved. An error row where the view should be is a failed server render and
  indeterminate; Next's redirect and not-found signals mean the route changed.
- The tracker shows each clock as the scan's local time, without an offset. A scan in a
  country that keeps one clock (New Zealand outside the Chatham Islands, China, Hong Kong,
  Japan, Singapore, the United Kingdom) is read in its zone. Australia and the United States
  span several zones and a scan names only its town, so their scans keep a local time, as
  do scans without a country. The label-data scan (`CI02`) keeps a local time everywhere:
  its clock matched a shipper's UTC dispatch for one parcel and the origin hub's for others.
- Codes decide the stage. The tracker reworded every code, and older parcels keep the old
  wording. A code the map does not know falls to the shared wording rules.
- Scans stay in the page's order, newest first. Instants and local times cannot be sorted
  together, so only scans sharing one clock are reordered, the further milestone first: the
  page can list an out-for-delivery scan above the delivery at the same minute.
- The location is the scan's town and country code, as the page shows them.
- The estimate is one day or a window, swapped when reversed. It is dropped when the page
  replaces it with "Please contact customer service" (`eddstatus`), and once the parcel is
  delivered or waits for collection.
- ePost Global and Asendia name DAI Post as the delivering partner through its tracking
  link.

## Numbers

DAI Post tracks the numbers its shippers print: SSCCs behind the `00` identifier with extension
digit 3 and the GS1 prefix 9358094 for Australia, `NZC` and nine digits for New Zealand, and
shippers' own references. `dai-post-1` claims `NZC` and nine digits; Purolator's three-letter rule
excludes `NZC`. [Freightways Global](../freightways-global/README.md), which delivers them in New
Zealand, shows the same numbers on its own tracker. `dai-post-2` lists the SSCCs first among the
SSCC candidates, so preflight asks this adapter. Shippers' references have no rule. Inputs other
than 8 to 40 letters and digits, with a digit, are invalid without a request, so a list of numbers
is never sent.

## Limitations

- Australian and US scans have no instant.
- A parcel waiting for collection names only the town of the point holding it.
- The page shows no proof of delivery, service or weight.
- Customs holds and returns, which the help page mentions, were not seen live and their
  codes are unmapped.
- Partner references, such as an ePost Global number, are not found.

## Testing

Set `DAI_POST_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/dai-post/adapter.live.test.ts`.
Optionally set `DAI_POST_UNKNOWN_NUMBER` to check a not-found number.
