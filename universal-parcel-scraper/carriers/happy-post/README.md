# Happy-Post

Happy-Post is a parcel-sending service run by Landmark Global, part of bpostgroup. Tracked
through the lookup its tracking page makes, for Happy-Post's own parcel numbers.

## How it works

1. `direct`: one `GET https://app.happy-post.com/api/v1/tracking/{number}`, the request the
   tracking pages on happy-post.com and uk.happy-post.com make. It needs no cookie, token, key
   or browser; the page's settings carry an empty reCAPTCHA key and the lookup sends no token.
   The UK site's own API host gives the same answers, so one host serves both.
2. `retry`: a lookup that fails to reach the service, or hangs, runs once more within the
   budget. The first try gets half of the budget.

- The JSON reply lists the tracker's steps in journey order, each with a timestamp once it is
  reached. A number the service does not know gets an empty HTTP 404 from the API view, which
  names the methods it allows in `Allow`; that is not found. The site's HTML 404 page is a
  route the API no longer has, and a 403 or a bot check is a challenge.
- The reply does not repeat the number. The service reads the number as an integer, so the
  adapter sends the whole number and refuses one with a leading zero, which would name another
  parcel.
- Recognition makes the same lookup.

## Notes

- A sender drops the parcel at a Mondial Relay, Chronopost, Colissimo or Colis Privé point, or
  has it collected, and that network carries it to Happy-Post's hub. The hub checks the parcel
  and applies the final label of the delivering carrier: bpost items issued through Landmark
  Global, or carriers such as Deutsche Post, Colissimo, Colis Privé, GLS, DHL Express or MRW.
- A step can carry a link to the tracking page of the network carrying that leg, sometimes
  before the step is reached. The link after the hub, usually on the delivery step, gives the
  delivering carrier and its number through the catalog's link rules, as a pasted link would.
  The drop-off network's link on the collected step is not kept.
- The page also asks `/orders-lines/{number}/distributor-number` for the international number.
  It is often empty and can differ from the number in the delivery step's link, so the adapter
  makes no second request.
- Each step is described by the label the French tracking page gives its code, and staged by
  the code in [status.ts](status.ts). A code the page has no label for shows as the code, as
  on the page.
- Timestamps carry no zone, so they stay wall clocks; the page shows the day only. The steps
  keep the reply's journey order, since clocks without a zone along an international journey
  cannot order them.
- The reply can flag a delivery problem on the newest step. The current page does not show it,
  and the adapter does not read it.

## Limitations

- Milestones only: no scan locations, ETA, weight, service or delivery instant with a zone. The
  delivering carrier's own tracking has the detail.
- Older parcels drop out of the tracker, which then answers not found.

## Numbers

Happy-Post's own parcel numbers are runs of seven or eight digits. Mondial Relay, Colisweb,
Heppner and SEUR numbers share these shapes, so no rule claims them. The numbers are issued
in sequence, so the tracker finds a parcel for almost any number in its current range: an
answer cannot show that another carrier's number is Happy-Post's. The tracker shows the
delivering carrier's number as the international tracking number, and detection names that
carrier for it.

## Links

The French and English tracking pages on happy-post.com and the tracking page on
uk.happy-post.com open one parcel when its number is in the `id` parameter. happy-post.com
sends visitors from countries such as the UK and the US to uk.happy-post.com, where neither
its French nor its English tracking address opens the parcel. uk.happy-post.com opens in every
country, so the link and the search page open its tracker.

## Testing

`npm run test:carriers:live -- carriers/happy-post`, with `HAPPY_POST_TRACKING_NUMBER` and
optionally `HAPPY_POST_UNKNOWN_NUMBER` set outside the repository.
