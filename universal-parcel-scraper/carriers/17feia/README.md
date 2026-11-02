# 17FEIA

17FEIA (上海宏杉国际物流) consolidates parcels in Shanghai and Shenzhen, flies them to Europe or
the United States and hands them to a delivering partner such as DPD Germany, DHL or FedEx.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.17feia.com/public/v1/ordeSearch/listTrackInfos/{number}`, as
   the tracking page's script sends it. It needs no cookie, token, key, account or browser. The
   JSON reply holds the order, its delivering partner and number, and its rows with English
   descriptions; `listZhTrackInfos` gives the same rows in Chinese.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- The lookup also finds an order by its partner's number or another forwarder's number, so the
  order counts only when its own number is the one asked.
- `flag: false` with nothing else is the unknown-order answer; the lookup gives the same for a
  box number and for anything that is not a number. Any other refusal, or an order without
  rows, is inconclusive.
- Redirects are not followed. A redirect to the site's cookie check, or an Aliyun bot check in
  place of the reply, is a challenge.
- Recognition makes the same request.

## Notes

- Every row carries 17FEIA's label in Chinese whatever the reply's language. The map reads the
  label; rows relayed from the partner share one label, so their stage comes from the partner's
  wording. The broker's "delivered to warehouse" is customs, and the row written before the
  warehouse has the parcel is a registration.
- A row is read on the clock its place keeps: its country's when the country has one, and in
  the United States its state's when the state has one. The warehouse's rows and the partner's
  relayed scans name such a place. A `timeZone` the place's clock does not have at that time
  keeps the wall clock, and so does a US row at midnight sharp: FedEx writes its pickup as a day,
  under another offset than its state's.
- 17FEIA's own milestones name no place. Their `timeZone` is one offset per line whatever the
  season, and one export declaration carries one destination's offset on an order and another's
  on another, to the second, so it is not their clock. The steps at the warehouse in China before
  the flight, from the row written twelve hours after the order data to the export declaration,
  are read on Beijing time: the backend writes the warehouse's receipt on it, and DPD Germany
  records the order that receipt creates minutes later. The flight's and customs' milestones may
  be on China's clock or the destination's, so they keep their wall clocks, and the parcel's
  places date them: the take-off on the warehouse's clock, and from the landing on the delivering
  partner's. Read so, an order's take-off and landing lie a long-haul flight apart.
- The newest scan's instant, when it has one, is the last update, and a delivered scan's is the
  delivery time.
- The estimated departure is written before the flight and is no scan: the adapter drops it.
  Rows dated after the read are dropped too. A delayed flight is no movement: the row keeps the
  stage of the row before it.
- The partner is handed over from an explicit table of 17FEIA's names: `DPD-DE` to `dpd-de`,
  `DE-DHL` to `dhl` and `FEDEX-GROUND` to `fedex`, and only when the partner's detection accepts
  the number. A DPD number is passed as the fourteen digits DPD's tracking takes, without a
  label's check character. Other names give no hand-off.
- A US row's state is read only for its clock. The rows' postcodes, the order id and the weight
  are never read.

## Limitations

- No delivery estimate, delivery time, weight, service, sender or recipient.
- Box numbers, the order number with a box suffix, are not looked up: the lookup does not answer
  them.
- Parcels bound for Poland or the Netherlands ride on DPD Germany's labels; once they leave
  Germany, `dpd-de`'s answer for them is inconclusive.
- A first visit to the tracking link lands on the cookie check, which reloads the home page
  without the number.

## Numbers

17FEIA's tracking page gives `FEI`, two letters, ten digits and `YQ` as its example layout.
The parcels ParcelPanel's 17FEIA page offers follow it with `FEISZ` for Shenzhen departures,
and 17FEIA's tracker answers them. `17feia-1` claims the layout. No sample ends in other
letters, so `17feia-2` only suggests 17FEIA for them, with low confidence, and recognition asks
its tracker. The tracker also names the delivering partner and that partner's own number, which
stays with the partner's rules.

## Testing

`SEVENTEENFEIA_TRACKING_NUMBER=... SEVENTEENFEIA_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/17feia`
