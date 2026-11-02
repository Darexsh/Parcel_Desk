# GO Logistics

Go Logistics Pty Ltd, in Camellia near Sydney, has been a business courier since 2005. It delivers
the same day across Sydney, the Central Coast, Wollongong and the Blue Mountains and overnight to
Newcastle, Canberra and regional New South Wales, sells prepaid coupons and stores goods for its
clients. Its site is gologistics.com.au. The adapter reads its public tracker.

## How it works

1. `direct`: `GET services.gologistics.com.au/track/iframe2.php?item={number}`, the frame the
   site's tracking page embeds, without a session or CAPTCHA. The page repeats the number asked as
   its heading, which must be the one asked, then lists the consignment's scans, oldest first, each
   with a day, a time, the driver's number and a wording. A number with no scan has the heading
   alone, which is read as not found: the page answers any string so.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs. The first
   attempt gets half of the budget.

Recognition asks the same page: a scan says GO Logistics holds the number.

## Notes

- Scans are dated on Sydney's clock without an offset.
- The scans carry no code; their wordings are mapped in [statuses.json](statuses.json), and another
  wording falls to the shared wording rules.
- A delivery adds the signatory, the number of pieces and the signature image. These and the
  driver's number are not kept.
- The tracker keeps scans for years, and a number used again lists every consignment under it,
  oldest first. A delivery followed by a new booking or collection closes the earlier one, so only
  the latest consignment is read.

## Numbers

Its coupon and consignment numbers are ten digits in the one public example. Ten digits are a shape
that many other carriers' rules and samples also read, so no rule claims it. The tracker matches a
number whole; neighbouring numbers belong to other consignments. The adapter takes six to twenty
letters and digits, as the tracker does not say which other layouts it issues.

## Links

The tracker's frame takes the number in the `item` parameter.

## Testing

Set `GO_LOGISTICS_TRACKING_NUMBER` and `GO_LOGISTICS_UNKNOWN_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/go-logistics-au`.
