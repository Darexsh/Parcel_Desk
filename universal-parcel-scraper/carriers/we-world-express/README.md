# We World Express

Tracks parcels of We World Express, a Hong Kong joint venture of Turkish Airlines' cargo arm, ZTO
and PAL Air, carrying e-commerce parcels from China and Hong Kong to Turkey and handing them to
Turkish carriers for delivery. Its site is weworldexpress.com.

## How it works

1. `direct`: one POST of `{"orderIds":["<number>"],"language":"en_US"}` to `/wwe/queryTrack2`, the
   endpoint its tracking page calls, which answers with the order's scans.
2. `retry`: the same read once more after a request fails to reach the endpoint or hangs. The
   first gets half of the budget.

No account, key, cookie, CAPTCHA or browser is needed.

## Notes

- The reply's `data` is the order as a JSON string. A number the tracker has no order under comes
  back unsuccessful with "Order does not exist": not found. Another unsuccessful answer is no
  answer.
- Each scan names its order; a scan under another number is no answer.
- Rows of code 08, scans unbound from the order, are left out, as the page does. For the
  warehouse's codes the page writes its own English, used here: their remarks can name the
  warehouse's operator.
- The endpoint takes about eleven seconds to answer, found or not, so the adapter's default
  budget is 30 seconds. Recognition is not declared: the lookup is slower than its budget.
- Scans give a wall clock and their offset in a field of their own. The order's row has none and
  keeps its wall clock.
- Aras Kargo's scans after the hand-off are relayed. Once a row hands the parcel to Aras Cargo,
  the order's logistics number, which Aras Kargo's tracker knows, becomes the delivery number.

## Limitations

The reply has no summary status, service or destination. The parcel's stage is its newest staged
scan. Other delivering partners' hand-off rows name no carrier id yet.

## Numbers

Its tracker's placeholder and customer complaints show WWE, two letters, ten digits and YQ. The
complaints come from one complaint site, so the rule is low. SkyNet Worldwide is also called
SkyNet WWE, so the bare initials are not an alias.

## Links

The tracking page takes the number in its form, so no address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/we-world-express`, with `WE_WORLD_EXPRESS_TRACKING_NUMBER`
and optionally `WE_WORLD_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
