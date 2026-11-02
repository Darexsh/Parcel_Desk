# XGS

XGS (Xpress Global Systems) is a US less-than-truckload carrier specialised in flooring, based in
Chattanooga, Tennessee. Its site is xgsi.com.

## How it works

1. `direct`: one `GET https://api.xgsi.com/shipments/track?trackNumber={probill}&type=probill`, the
   request the site's tracking widget makes. It needs no key, cookie or browser.
2. `retry`: the request once more when it fails to reach the API or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A probill the API does not hold gets HTTP 404 with `Track(s) not found with provided id(s)`,
  read as not found. Any other 404 or a redirect is a moved route, a 403 or a firewall page is a
  challenge and a 429 is a rate limit.
- The entry answered must carry the whole probill asked.
- Recognition makes the same request.

## Notes

- The reply has no history: a status code with its words, the bill day, the arrival at the
  destination hub, the delivery's day and time and the day XGS plans to deliver. The code is the
  provider code; the newest of the delivery, the hub arrival and the bill day dates the status.
  Times are wall clocks with no zone and stay `local_time`.
- The status map lists the codes the widget tests: delivered and warehoused at the destination.
- The signatory, the consignee's ZIP code, the towns, the hubs, the payor and the weight are not
  read; the reply does not say the weight's unit.

## Limitations

- A summary only: no history, places or instants.
- Bills of lading and purchase orders, which the API also takes with another `type`, are not
  asked.

## Numbers

Its probill numbers are seven or eight digits, lengths many carriers share, so there is no rule.

## Links

The site opens a probill from `#track-shipment=` in its address.

## Testing

`npm run test:carriers:live -- carriers/xgs`, with `XGS_TRACKING_NUMBER` and optionally
`XGS_UNKNOWN_NUMBER` set outside the repository.
