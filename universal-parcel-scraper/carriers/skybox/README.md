# SkyBox

SkyBox is a Miami package-forwarding service, a SkyNet affiliate: customers get a US suite address, and SkyBox
flies their purchases to Latin America for delivery. Its site is skybox.net.

## How it works

1. `direct`: one `GET https://www.skybox.net/TrackingInformation/GetContentPublic?tracking={number}`, the HTML
   fragment its public tracking page loads. It needs no cookie, session, CAPTCHA or browser, and answers in
   English whatever language is asked.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try gets half of the
   budget, so the retry fits in the rest.

- The fragment's search box carries the number asked, which must be the number requested.
- A number the tracker does not know gets HTTP 200, the skybill id 0, the whole message
  `The tracking number does not exists` and no card; that is read as not found. Any other fragment without a
  card is a schema error. A redirect, such as to the site's error page, or a 404 is a moved route, a firewall
  page is a challenge and a 429 is a rate limit.
- The card's SkyBox number, printed as four digits, a dash and eight digits, must be the whole number asked.
- Recognition makes the same request.

## Notes

- Each row of the tracking table is a wording, a place and a wall clock to the minute with no zone, newest
  first. Rows come from SkyBox's Miami warehouse and from the destination country, so times stay `local_time`:
  consumers date each scan by its place, else by the catalog's Miami clock.
- The map stages the wordings seen. Other wordings go through the shared wording rules, and one they do not read
  has no stage.
- The status bar above the table repeats the table's milestones by day, so it is not read.
- The card's number the parcel arrived under, reception date, suite, origin, destination, consignee, weight and
  items are not read.

## Limitations

- No instants, codes or expected delivery.
- The tracker also finds a parcel by the number it arrived under at the warehouse. The adapter asks only for
  SkyBox numbers, and an answer naming another SkyBox number is indeterminate.

## Numbers

Its numbers are twelve digits; the public example starts `0051`. Twelve digits are shared by many carriers, so
there is no rule, and recognition does not ask SkyBox. SkyNet Worldwide's tracker does not know SkyBox numbers.

## Links

The public tracking page opens numbers from its `tracking` parameter.

## Testing

`npm run test:carriers:live -- carriers/skybox`, with `SKYBOX_TRACKING_NUMBER` and optionally
`SKYBOX_UNKNOWN_NUMBER` set outside the repository.
