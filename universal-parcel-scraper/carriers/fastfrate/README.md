# Fastfrate

Fastfrate is a Canadian less-than-truckload and intermodal freight carrier. Tracked by probill
through the lookup its tracker's quick track page makes.

## How it works

1. `direct`: one `GET https://tracker.fastfrate.com/trackerapi/shipmentinformation/quicktrack?probillnumber={probill}`,
   as the quick track page at `tracker.fastfrate.com/quick-track` makes it. It needs no cookie,
   token, account or browser. The JSON reply holds the probill as a number, its timeline oldest
   first, the shipper's references and a service message.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A probill the service does not know comes back with an empty timeline, which the page reports
  as not found. A 404 or a redirect is a moved route.
- The reply must name the probill asked. The service reads the number as an integer and answers
  for what it read, and a missing number reads as 0, a record holding stray rows.
- The tracker's sign-in form asks for reCAPTCHA; the quick track lookup sends no token.

## Notes

- Each timeline row has a description, a wall clock to the second and, for terminal rows, the
  town and province. No clock names its zone, and Canada spans several, so the clocks stay
  `local_time` and there is no `delivered_at`. A midnight clock, as on an appointment request, is
  a date without a time.
- The driver's device adds its arrival at and departure from the shipper and the consignee, on a
  clock that can disagree with the rows terminals enter: those rows can come after the pickup or
  the delivery. The arrival at the shipper never steps a picked-up shipment back, and a delivery
  settles later rows of an earlier stage. Otherwise the newest staged row decides.
- The page shows the first "Estimated Delivery Date" row's day over the list and leaves the row
  out. A "Scheduled Appointment" row carries the appointment's own time, which can be ahead.
  Neither becomes a scan: the estimate is the appointment's day, else the estimated day, until the
  delivery.
- The shipper's references and the service message, which stands in for a missing estimate, are
  not read.
- The former FastNet page still answers. It shows a summary without a history: the pickup and
  delivery towns, pieces, weight, the delivery status and dates, and an appointment note that can
  name a person. The adapter does not read it.
- Beyond carriers, documents and proof of delivery need a customer account, so there is no
  hand-off.

## Limitations

- No sender, recipient, weight, service, beyond carrier or delivery receipt, and scans have no
  offset.
- A probill reaches the adapter when it is filed under Fastfrate or opened from a Fastfrate link:
  ten digits are shared by many carriers, so no rule claims them and preflight does not ask it.

## Numbers

Fastfrate tracks a shipment by its probill number. Lookups archived from its own tracker show ten
digits. Ten digits are shared by many carriers, so no rule claims them. The quick track page
takes more than five digits and the FastNet field at most ten, and the service reads the probill
as a number, so the adapter takes six to ten digits that do not start with 0. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The FastNet quick probill tracker opens one shipment from `ProbillNo` on `FastNet.aspx`,
on `apps.fastfrate.com` and formerly on `www.fastfrate.com`. The newer tracker takes the
number in a form and fetches it from its script, so it has no address of its own.

## Testing

`npm run test:carriers:live -- carriers/fastfrate`, with `FASTFRATE_TRACKING_NUMBER` and
optionally `FASTFRATE_UNKNOWN_NUMBER` set outside the repository.
