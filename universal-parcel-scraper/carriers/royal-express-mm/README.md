# Royal Express Myanmar

Royal Express is a Yangon-based domestic parcel and express network in Myanmar. Tracked through
the form on its tracking page.

## How it works

1. `direct`: `GET https://royalx.net/tracking` for the form's `_token` and the
   `royal_express_session` cookie it belongs to, then a `POST` to the same address with `_token`
   and `waybill-number`, as the form sends them. It needs no key or browser. The answer is the
   page again, with the parcel's scans, newest first.
2. `retry`: both requests once more after a network failure or timeout. The first try gets half
   of the budget.

- An unknown waybill is HTTP 200 with the line `Waybill No not found with this Tracking Code`
  and the waybill. The page must name the waybill asked, there or under `Tracking No.`.
- A token the session does not hold gets Laravel's HTTP 419, and a form the tracker will not
  take is sent back with a redirect. Both mean the page changed, not that the parcel is missing.
  A 404 is a moved route.
- The tracker matches whole waybills in any case. Part of one, or two joined, finds nothing.
- Recognition makes the same requests. No detection rule offers Royal Express, so recognition
  is not asked until one does.

## Notes

- Each scan has a heading, its leg and step (`Delivery - completed`), over a Burmese sentence
  with its clock. The heading in lower case, `delivery-completed`, is the scan's code and stages
  it, since every transit step has the same sentence: received at the office.
- The sentence starts with the office (`MDY-C2 ရုံးမှ`, from the MDY-C2 office). That office,
  with the township the page names beside its code, is the location; the rest is the
  description.
- Clocks are wall clocks to the second with no zone. Royal Express works within Myanmar, but the
  page does not say which clock it shows, so they stay `local_time`.
- `Delivery - accepted` is the delivering office preparing the delivery. A delivery under way or
  a failed one follows it, so it comes before the round. `Delivery - rejected` is a failed
  delivery, and `reattempted` sets another.
- The page shows the sender's and receiver's towns and names, and after a delivery the name of
  who took the parcel. None is kept.

## Limitations

- No estimate, weight, service or proof of delivery, and no delivery time as an instant.
- The tracker drops older waybills, which then read as not found.

## Numbers

A branch waybill is the sending office's three letters, digits and the destination's three
letters; a member waybill, from the business app, is three letters and six digits. Recent
branch waybills have eight digits, the tracking page's placeholder eleven and the home page's
seven. The home page's placeholder also joins a member waybill with a slash; the adapter takes
each waybill on its own. The public samples come from Royal Express's own pages and posts, and
the digit count has changed over the years, so no rule claims these layouts yet.

## Links

The tracking form posts the waybill with a session token, so no address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/royal-express-mm`, with
`ROYAL_EXPRESS_MM_TRACKING_NUMBER` and optionally `ROYAL_EXPRESS_MM_UNKNOWN_NUMBER` set outside
the repository.
