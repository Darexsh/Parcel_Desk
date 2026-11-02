# XDP

XDP, a UK next-day and two-person delivery network. Tracked by consignment number and
delivery or collection postcode through XDP's legacy tracking page, which its delivery emails
still link to.

## How it works

1. `direct`: one `GET https://www.xdp.co.uk/track.php?c={number}&code={postcode}`. The page is
   rendered on the server; it needs no cookie, key, account, CAPTCHA or browser. The adapter
   follows no redirect.
2. `retry`: one more try when the request fails to reach XDP or hangs. The first try gets half
   of the budget.

- The postcode is required, and every route to a consignment asks for it: this page, the
  newer `xdp.co.uk/track/` page and the XDP app's service. It is optional in the catalog, so a
  parcel saved without it is tracked through enabled universal providers instead; the adapter
  then asks XDP nothing. The postcode is case-insensitive and works with or without its space.
- The page echoes the number in its form, and each scan names the barcodes it covers: the
  number and a three-digit piece. Both must match the requested number, otherwise
  `SchemaError`.
- An unknown number and a wrong postcode get the same notice, "Consignment not found":
  `NotFoundError`. A lookup without a postcode gets a notice asking for one. Any other notice,
  page or a missing page is inconclusive.
- No recognition: without the postcode the page answers nothing.

## Notes

- This page lists every scan with its status type. The newer `xdp.co.uk/track/` page shows
  only four milestones, so it is not used. The XDP app's service needs the postcode too.
- Stages come from the status type. `DELIVERY` covers the delivery depot's work, so its
  wording decides: XDP's newer page counts a parcel out for delivery from the scheduled round,
  and the depot scan and the van allocation before it as being prepared.
- After a return label, every later scan is staged `returned`.
- Notification rows (emails, text messages and the delivery confirmation message) are dropped:
  they move nothing, and some name the recipient. Wording that goes on to name a person is
  cut before the name.
- A consignment of several pieces repeats each scan once per piece; repeats are dropped.
- Clocks are UK wall time without an offset. The page prints a 24-hour clock with a meridiem;
  a meridiem that disagrees with the hour is rejected.
- The weight and service are kept. The recipient's name, company and postcode, the references,
  the location column's depot, driver and account codes, the piece count and the delivery
  window are never read.

## Numbers

XDP consignments are `ZDB`, three letters and six digits. Reviews, complaints and lookups
archived from XDP's own tracker show them; one complaint prints a leading zero, which the
tracker does not know, so the adapter drops it. `xdp-1` claims the shape with or without that
zero. A complaint also calls a twelve-character hexadecimal value its tracking, which no rule
claims.

## Links

The link opens the newer `xdp.co.uk/track/{number}` page with the number filled in; it asks
for the postcode. Archived links put the consignment in the path of `xdp.co.uk/track/` or in
`c` on `track.php`; only the number is read from them.

## Limitations

- No tracking without the postcode.
- No scan location or delivery estimate.

## Testing

```sh
XDP_TRACKING_NUMBER=... XDP_POSTCODE=... XDP_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/xdp
```
