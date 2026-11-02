# eCourier

eCourier is a Dhaka-based courier that delivers online orders for merchants across Bangladesh,
and packs orders from the stock some merchants keep in its fulfilment centre. Tracked through
its tracking page.

## How it works

1. `direct`: one `GET https://ecourier.com.bd/tracking/?tracking_no={number}`, the page the
   site's tracking forms open. The server renders the parcel into it; there is no separate
   lookup, and it needs no cookie, token, captcha, phone digits or browser. The page has the
   parcel's package information and its scans grouped by day, newest first.
2. `retry`: one more read when eCourier cannot be reached or does not answer in time.

- An unknown ID gets the same page with `No Result Found` in place of the parcel, which is not
  found. Recognition makes the same request.
- The package information must name the whole ID asked.
- A 404 or a redirect is a moved route; a firewall page or a bot check, even with HTTP 200, is a
  challenge.

## Notes

- Each scan has a day heading, as `Tuesday, March 3 2026`, and a minute, as `2:05 pm`, without
  a zone. Bangladesh keeps one zone without daylight saving time, so they are read as Dhaka
  time.
- Scans have no code, so their wording stages them. Each names its location, which is kept, and
  the staff member, branch or rider who made it, with the rider's phone number, and their
  group, which are not. The page lists some scans twice at the same minute; they are kept
  once.
- `Delivery Agent Assigned` is the rider taking the parcel at the delivering branch, so it stays
  in transit; `On the way to Delivery` is out for delivery.
- `Delivery Type` is the service name. The order's creation day and the time since, and the
  merchant's and recipient's names and addresses are not kept.
- eCourier's merchant API needs the merchant's keys and is not used.

## Limitations

- No estimate, weight or proof of delivery.
- Returns, failed deliveries and IDs starting with `BL` have not been seen on the page.

## Numbers

eCourier IDs are `ECR` followed by digits; eCourier's merchant API documentation shows ten,
thirteen and sixteen digits, and `ecourier-1` claims that layout. The tracking form takes IDs
starting with `ECR` or `BL` with eleven characters or more. No `BL` ID has been published, so
no rule covers them; the adapter takes `ECR` and digits, or `BL` and letters and digits.

## Links

The tracking forms on ecourier.com.bd open `ecourier.com.bd/tracking?tracking_no={number}`.

## Testing

`npm run test:carriers:live -- carriers/ecourier`, with `ECOURIER_TRACKING_NUMBER` and
optionally `ECOURIER_UNKNOWN_NUMBER` set outside the repository.
