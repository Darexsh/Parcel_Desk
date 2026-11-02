# Starex

Starex (Starex MMC) brings online purchases from Turkey, the United States and China to
Azerbaijan through its warehouses abroad, clears them through customs and hands them over at
its branches and pickup points or by courier. Its site also takes parcels for Uzbekistan.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://api.starexglobal.com/api/v1/starex/packages/{number}/history`,
   the request the tracking page on starexglobal.com makes, with the site as `Referer` and
   English as the language. It needs no cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the service, or hangs, runs once more within the
   budget. The first try gets half of the budget.

- The JSON reply lists the parcel's scans newest first. A number the tracker does not know gets
  HTTP 404 with an empty `message`, which is not found.
- Without the site's `Referer` the API answers HTTP 404 with `"message": "Not found"` for every
  number, known or not, so that reply is a refusal, not a missing parcel. A 404 naming a route
  the API does not have, or any other 404, is a moved route.
- The reply does not repeat the number. The adapter asks for the whole number in the path and
  refuses a redirect, which would answer for another path.
- Recognition makes the same lookup.

## Notes

- A scan's description is the page's title for it, then its sentence, such as
  `Customs Hold: The package has been referred for additional customs inspection.` Its status
  code stages it. One code covers a customs hold, a missing declaration and a review after the
  declaration; the wording tells them apart.
- Clocks are `DD-MM-YYYY HH:mm` with no zone, from warehouses abroad and in Azerbaijan, so they
  stay wall clocks. Scans on one clock keep the reply's order, as on the page.
- A delay notice and a request to pay the delivery fee say nothing of where the parcel is and
  have no stage. The codes of the former parcel page on starex.az are still mapped.
- The reply also carries the recipient's masked name, phone and personal identification code,
  their chosen branch, and the shop's order number for the leg to Starex's warehouse abroad.
  The adapter keeps none of them. The order number tracks the parcel before Starex has it, so
  there is no hand-off.

## Limitations

- Milestones only: no scan locations, ETA, weight, service or delivery instant with a zone.
- Old parcels drop out of the tracker, which then answers not found.
- The adapter takes only the two layouts below. Numbers of parcels sent to Uzbekistan have not
  been seen.

## Numbers

Starex's tracker shows `STRAZ` and twelve digits. Customers' public complaints give such
numbers, and the tracker knows them. Colis Privé's catch-all rule takes the shape, so no rule
claims it yet.

An archived lookup on Starex's former parcel page carries `STR` and nine digits. That is
inside the three letters and nine digits that `purolator-2` claims, and one lookup is too
little to set the prefix apart, so no rule claims it.

## Links

The tracking box on `starexglobal.com` opens `/az/tracking/{number}` (also under `/en/` and
`/ru/`), which loads the history. The former site on `starex.az` read the number from
`?parcelNumber=` on `/baglama/`. The library reads the number from both.

## Testing

`npm run test:carriers:live -- carriers/starex-az`, with `STAREX_AZ_TRACKING_NUMBER` and
optionally `STAREX_AZ_UNKNOWN_NUMBER` set outside the repository.
