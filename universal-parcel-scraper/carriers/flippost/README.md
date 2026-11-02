# Flip Post

Flip Post (Флиппост) is a Moscow express courier with its own branches and agents across Russia
and international document and parcel services. Tracked through the tracking request of its
documented client API.

## How it works

1. `direct`: `GET https://web.flippost.com/fp/client/api.php?dbAct=getTrackInfo&wbno={waybill}`,
   the tracking request Flip Post's API manual documents. It needs no key, cookie or browser.
   The JSON reply lists the waybill's rows oldest first, each with a status, a town or leg and
   a clock.
2. `retry`: a request that fails to reach the API, or hangs, is sent once more. The first try
   gets half of the budget, and only a reading without an answer is asked again.

- The tracking page on flippost.com asks for a Yandex SmartCaptcha before it looks a waybill
  up, so the adapter reads the API instead. Only `getTrackInfo` is asked.
- The API finds a waybill only with its dashes, which the library drops. The adapter puts them
  back: seven digits are three and four, nine are two and seven. Eight digits are four and four
  or two, three and three, so both readings are asked together. The one with rows is the
  answer; rows for both are inconclusive. A number that keeps the dashes of a layout is asked
  as it is.
- `success` true with an empty `data` is the API's only answer for a waybill it holds nothing
  for, unknown or with its history purged: an archived history of a waybill now answers that
  way. The adapter reads it as not found. `success` false is inconclusive, a 404 or a redirect
  is a moved route, and a browser check is a challenge.
- The rows do not name the waybill, so an answer is bound to the number only through the
  request.
- Recognition makes the same request.

## Notes

- A row's clock is a day, a month and a two-digit year, with a time or without, and no zone.
  The rows name towns across Russia's zones, so clocks stay `local_time`. Rows without a time
  come at 00:00, and the manual's example gives the same rows as days alone, so midnight keeps
  the day only.
- A row's status (`astatus`) stages it and is its provider code; the town or leg follows it in
  the wording. A leg's row takes the leg's origin as its location. A delivery's wording loses
  the receiver's name.
- "Планируемая дата отправки" is the planned dispatch date of a leg. As the first row it
  registers the waybill. After the parcel has moved it is in transit: an archived reply has it
  where the manual's example has the same leg on the road. A date still to come is no scan and
  stays out of the history, and a waybill with nothing else reads as registered without scans.
- "Прием возвратов от курьера", returns taken back from the courier, is a failed attempt: the
  parcel came back from the delivery round.

## Limitations

- No delivery estimate, weight or service name. The rows' `expected_at` is not read.
- A waybill the API has no rows for yet reads as not found, like an unknown one.

## Numbers

Flip Post's number is a waybill (накладная) written as digit groups joined by dashes: a short
prefix, then the serial. The tracking API manual, the client cabinet help and court rulings
that cite Flip Post waybills show two digits and seven, two digits and two groups of three, and
three or four digits and four. Detection drops the dashes, which leaves bare runs of seven to
nine digits that many carriers share, so no rule claims them and the gaps are declared. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking form on the home page and on the tracking page sends the waybill in the `number`
parameter of `flippost.com/instruments/online/`, so that address opens one parcel. The page
fills its field in from the address and asks for the captcha before any lookup. The library
reads the number from the address. A link gives seven or nine digits their dashes; eight
digits fit two layouts and stay as given.

## Testing

`npm run test:carriers:live -- carriers/flippost`, with `FLIPPOST_TRACKING_NUMBER` and
optionally `FLIPPOST_UNKNOWN_NUMBER` set outside the repository.
