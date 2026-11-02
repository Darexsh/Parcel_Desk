# City-Link Express

City-Link Express is a Malaysian courier. Tracked through the lookup its tracking-result page
makes.

## How it works

1. `direct`: one `POST https://www.citylinkexpress.com/wp-json/wp/v2/getTracking` with the form
   fields `tracking={number}` and `xr_option=false`, as the tracking-result page sends them for
   the consignment number in its address. It needs no cookie, nonce, CAPTCHA token or browser.
   City-Link's answer is in `req.data`, with the scans in `trackDetails`, oldest first.
2. `retry`: a read that failed to reach the site, or hung, is sent once more. The first gets half
   of the budget.

- A number City-Link has no record of is HTTP 404 with `{"error":"No tracking data found."}`,
  which the page reports as not found. Any other 404, such as WordPress's `rest_no_route`, or a
  redirect is a moved route.
- A `returncode` other than `00`, or a failed `req.status`, is inconclusive. The page words it as
  no details found, but the tracker answers an unknown number with the 404.
- The shipment must echo the number asked.
- Cloudflare is in front of the site. Its refusal or challenge page is a browser check, never a
  missing parcel. The package's default User-Agent passes.
- Recognition makes the same request.

## Notes

- Each scan's `detDate` and `detTime` are a wall clock with no zone. A scan is dated at +08:00
  when the country after its location's last comma keeps Malaysia's clock at that moment, as
  Malaysia, Singapore and Brunei do: the reading is then the same whether the branch or
  City-Link's system stamped it. The shipper's record has no location and keeps `local_time`,
  as does a scan in a country on another clock.
- `CP_Code` stages a scan. A problem scan's (`SP`) reason is its `DisposeCode`, which the
  provider code keeps after a colon, as `SP:60`, and only the reason seen is mapped. Other codes
  fall to the shared wording rules.
- The page drops `SR - ` from the shipper's record's wording, and so does the adapter.
- The courier an out-for-delivery scan names and the person a delivery scan says signed are
  dropped from the wording, and so are phone numbers.
- The scans decide the stage. The page's four-step progress rail is not read.
- The weight is kept, in kilograms. The origin and destination station codes, the sender's
  reference, the kind of shipment and the child pieces are not.

## Limitations

- No estimate or service name, and no instant for scans that keep `local_time`.
- Proof of delivery asks for the shipper's or recipient's contact number or the account number,
  and is not read.
- The page's second box looks up senders' references (`xr`). No rule claims them, and the
  adapter asks consignment numbers only.

## Numbers

City-Link consignment numbers are fifteen digits; the tracker's forms ask for fifteen.
Lookups archived from City-Link's tracker and forum posts show them starting `0603` and, more
recently, `9603`. No rule claims them: detection compares numbers with spaces and hyphens
stripped, and fifteen digits are then a plain digit run other carriers print too. The samples
and their sources are in [`numbers.json`](numbers.json).

City-Link's tracking form opens `citylinkexpress.com/tracking-result/?track0={number}`,
numbering further consignments `track1` onwards. Older lookups used `cno` on
`ShipmentTracking_Details.aspx`. The library reads the number from both.

## Testing

`npm run test:carriers:live -- carriers/citylink-express`, with
`CITYLINK_EXPRESS_TRACKING_NUMBER` and optionally `CITYLINK_EXPRESS_UNKNOWN_NUMBER` set outside
the repository.
