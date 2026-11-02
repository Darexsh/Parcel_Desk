# T-CAT

T-CAT (黑貓宅急便) is President Transnet's door-to-door parcel network in Taiwan. It carries
Yamato Transport's black cat brand but runs its own tracker and numbers; `yamato` covers Japan.
Tracked through the page its tracker opens for one number.

## How it works

1. `direct`: one `GET https://www.t-cat.com.tw/Inquire/TraceDetail.aspx?BillID={number}`, the
   page the tracker's form and its result links open. It needs no cookie, ViewState, captcha or
   browser. The server writes the parcel's scans into a hidden table, newest first, which the
   page's script lays out; the adapter reads that table.
2. `retry`: the same request once more after a network failure or timeout. The first try gets
   half of the budget.

- A number without a status gets the page's own notice that its database has none for it, with
  the number echoed. That is read as not found. The tracker keeps three months of scans, so an
  older parcel gets the same notice.
- The page answers every number with HTTP 200. A redirect or a 404 is a moved route or an error
  page. A page without the status table is a changed page, or a challenge when it carries a
  browser check or a firewall refusal.
- The table must list the number asked and no other.
- Recognition makes the same request.

## Notes

- Each scan's clock is the day and minute the driver entered it, with no zone. T-CAT delivers
  only within Taiwan, which has one zone without daylight saving, so clocks are read in Taipei
  time.
- A scan's description is T-CAT's Traditional Chinese label, such as `轉運中`. The labels carry
  no code; the wording stages them, and a note in brackets after a label, as in same-day
  delivery's `配送中(當配下車)`, keeps the label's stage. The tooltips explaining each label are
  not kept.
- The location is the branch or transfer centre in charge of the scan, as the page names it.
- A cash-on-delivery parcel heading back (`客樂得貨物退回中`) stays returned: the transit and
  delivery scans after it carry the parcel to the sender.

## Limitations

- No estimate, weight, service, recipient or proof of delivery.
- Scans older than three months are gone.

## Numbers

T-CAT's help pages ask for the ten-digit number at the top right of the waybill, typed without
hyphens. Archived lookups on its tracker show ten-digit numbers and, on newer waybills,
twelve-digit ones. No rule claims them: bare ten- and twelve-digit numbers are printed by many
carriers.

## Links

`t-cat.com.tw/Inquire/TraceDetail.aspx?BillID={number}` opens one parcel. Archived lookups use
it with and without a `ReturnUrl` parameter; the parameter name and path are case-insensitive.

## Testing

`npm run test:carriers:live -- carriers/t-cat`, with `T_CAT_TRACKING_NUMBER` and optionally
`T_CAT_UNKNOWN_NUMBER` set outside the repository.
