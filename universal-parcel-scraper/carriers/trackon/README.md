# Trackon Couriers

Trackon Couriers is a domestic courier network in India. Its branches and franchisees book
consignments and deliver them across the country. Tracked through the lookup its Android app
makes.

## How it works

1. `direct`: one `GET https://api.trackon.in/MobileAPP/AndroidApi/t1/CustDetailTracking` with
   `AWBNo={number}`, `AppKey=3656` and `RequestType=AWBNo`, as the Android app sends it. The app
   key is the same for every install. The service does not check its value, but answers a
   request without it with HTTP 404. No account, cookie, captcha or browser is needed. The JSON
   reply has the consignment's summary and its scans, newest first.
2. `retry`: a request that fails to reach the service, or hangs, is sent once more within the
   budget.

- `ResponseStatus.Message` says how the lookup went. `NOT FOUND` is the service's answer for a
  number it has no consignment for. `Please enter Trackon AWBNo` is its answer for a number
  outside the series Trackon issues, which is an invalid input. Other messages are
  inconclusive. A 404 or a redirect is a moved route.
- The consignment must echo the whole number asked. The app's other request type, `RefNo`,
  looks up customer references and can answer with someone else's consignment without its AWB
  number. The adapter never uses it.
- The service answers some numbers it has nothing for with success and one empty scan dated
  01-Jan-0001. That placeholder is no history, not a consignment.
- Recognition makes the same request.

## Notes

- The website's tracker posts its form and renders the result on the server. It says a
  consignment's status is available for 75 days only; the app's lookup still answers older
  consignments.
- Each scan's `EVENTDATE` and `EVENTTIME` are a wall clock to the second, with no zone. Every
  scan is at a Trackon branch in India, which keeps UTC+5:30 all year, so the clocks are read
  in `Asia/Kolkata` and each scan gets a `time`.
- A scan's `TRACKING_CODE`, such as `DRBG`, is its `provider_code` and stages it. A scan
  without a known code goes to Trackon's own wordings, then to the shared wording rules. A
  return to origin, worded `RTO …`, is an exception until it is delivered back, then returned.
- The location is the branch the scan names, without its branch code.
- A delivery or return loses the remark after its wording, which can name who took the
  consignment, and every wording loses phone numbers. The origin, destination, postcode,
  customer reference, piece count, charged weight, product, service type, non-delivery reason
  and the proof of delivery, signature and non-delivery images in the reply are not kept.

## Limitations

- No expected delivery, service name or delivery partner.
- The histories the lookup returned list no hub scans between booking and the delivery branch.
- The app also takes seven- and eight-digit numbers, which it shows without branches. The
  adapter takes ten and twelve digits only.

## Numbers

Trackon's AWB numbers are twelve digits, and ten on older consignments. The service takes only
some leading digits and answers the others as not Trackon's. Digit runs of these lengths are
printed by many other carriers, so no rule claims them and preflight does not ask Trackon: a
number reaches the adapter when the user, a link or a provider names the carrier. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The home page's search markup declares `trackon.in/courier-tracking?awb={number}` as its search
address, so that address opens one consignment. The tracking forms themselves post the number.

## Testing

`npm run test:carriers:live -- carriers/trackon`, with `TRACKON_TRACKING_NUMBER` and optionally
`TRACKON_UNKNOWN_NUMBER` set outside the repository.
