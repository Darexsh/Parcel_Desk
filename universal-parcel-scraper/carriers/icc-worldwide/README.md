# ICC Worldwide

ICC Worldwide is an international courier serving India since the 1970s, with a network in the
US and Europe. It carries cross-border e-commerce and shop-abroad orders into India. Tracked
through the page its tracking form opens.

## How it works

1. `direct`: one `GET https://www.iccworld.com/track-result.php?track_no={number}`, as the
   tracking form on `www.iccworld.com` sends it. It needs no cookie, token, key or browser. The
   page renders the shipment as HTML: a summary headed by the air waybill, then a detailed
   report with a row per checkpoint, newest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A number without a shipment gets the summary's notice `Record not found`, which names no
  number. A 404, a 410 or a redirect is a moved route.
- The page splits what it is given on commas and shows one block per number. The adapter sends
  one whole air waybill and keeps a shipment only when the page heads its one block with that
  number; a block for another number, or several blocks, are inconclusive and nothing from them
  is kept.
- Recognition makes the same request.

## Notes

- The page says its times are local to the service area that recorded the checkpoint, and no
  clock names a zone. A row whose service area is in India, such as `MUMBAI`, `NEW DELHI` or a
  place ending in `INDIA`, is read on India's clock. Delhi alone stays a wall clock, as New York
  State has a Delhi too, and so does every row elsewhere and every row without a time.
- Once delivered, the summary shows the receiver's name and `Shipment Delivered at` with the
  delivery's day and time. That delivery settles the shipment; before its row comes in, it is the
  newest checkpoint, on a wall clock, since the summary names no place.
- The summary links the number a partner carries the shipment under, such as `BLUE DART -` and
  that number. It becomes the delivery carrier and delivery tracking number only for a label the
  older tracker printed for DHL, UPS, FedEx, Aramex, Blue Dart, TNT, USPS or DPEX, and only when
  one partner is shown. Other labels, such as `CITY-LINK`, the UK courier rather than the
  catalog's Malaysian one, are not kept.
- The customer's, consignee's and receiver's names are dropped from the rows. The origin, the
  destination and the names themselves are not kept.

## Limitations

- The parser reads a found shipment in the older tracker's layout, which the current page keeps
  for an unknown number. A found shipment laid out otherwise reads as a malformed reply, so the
  enabled fallbacks answer.
- No estimate, weight, service name or proof of delivery: the page shows none.
- A number reaches the adapter when it is filed under ICC Worldwide or opened from its link: no
  rule claims its numbers, so preflight does not ask it.

## Numbers

ICC air waybills are plain digit runs; the one public number found has eleven digits. The adapter
sends runs of seven to twelve digits and nothing else. No rule claims them, since many carriers
print digit runs of that length. The sample and its source are in [`numbers.json`](numbers.json).

## Links

ICC's track form opens one air waybill at `www.iccworld.com/track-result.php?track_no=`
followed by the number. Its older tracker used `track.asp?txtawbno=`, which no longer looks a
number up.

## Testing

`npm run test:carriers:live -- carriers/icc-worldwide`, with `ICC_WORLDWIDE_TRACKING_NUMBER` and
optionally `ICC_WORLDWIDE_UNKNOWN_NUMBER` set outside the repository.
