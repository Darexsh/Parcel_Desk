# Makati Express Cargo

Makati Express Cargo carries balikbayan boxes and air cargo door to door from Gulf branches
and other countries to addresses across the Philippines. Tracked through its tracking page.

## How it works

1. `direct`: one `POST https://makati-express.com/tracking/` with the form fields
   `awbnumber={number}` and `Submittrackwidget=Check`, as the page's form sends them. It needs
   no cookie, token or browser. The page comes back with the AWB's summary and its progress
   table below the form, numbered from the oldest row.

- An unknown AWB is HTTP 200 with a notice naming it, "Data not found / its not updated in the
  server, Please try again later". An AWB its branch has not uploaded yet gets the same answer.
  A 404 or a redirect is a moved route.
- The server answers a bare `Mozilla/5.0` User-Agent with HTTP 406, which the adapter reports
  as a challenge. The package's default User-Agent passes.
- The page takes several seconds to answer, so the single read gets the whole budget rather
  than half of it with a retry after.
- The page must name the AWB asked. It prints it in capitals, whatever case was typed.
- Recognition makes the same request.

## Notes

- Each branch's system prints its own page. Branches on the older system, such as Doha, print
  days as `2026-01-31`; the newer one, in Dubai, prints `31-January-2026, Saturday` and adds an
  office note column. Both are read, and a weekday must agree with its day.
- Rows have a day and no clock. Scans happen at the Gulf branch and in the Philippines, in
  different zones, so each stays a local day.
- Rows have no code. The activity, picked from a list each branch keeps, stages the row.
  Repeated rows on one day count once.
- Rows that announce a departure or arrival still to come, such as `ESTIMATED DEPARTURE` or
  `EXPECTED ARRIVAL AT MANILA PORT`, carry the day the branch expects. They are forecasts, not
  scans, and are dropped. The summary's status can be one of them, so the stage comes from the
  rows. A booking without rows is reported with the summary's status alone.
- Only the progress is kept. The summary's shipper, consignee, their city, receiver, box count,
  booking day and delivery day are not, nor are the rows' customer and office notes. Delivery
  rows lose a clause naming who took the box, and every row loses phone numbers.

## Limitations

- No clock, location, estimate or service: a row is a day and an activity.
- Branch serials come round again, so an AWB from years ago can open a later shipment.

## Numbers

The tracker takes the AWB number with the sending branch's three-letter code in front, as
Makati Express's support agents tell customers on its own forum, such as `DXB` for Dubai and
`DOH` for Doha. Numbers seen have seven or eight digits after the code. `makati-express-1`
suggests the carrier for the Dubai, Doha, Fahaheel and Taif codes at low confidence, and
recognition asks the tracker. Australia Post's rule for three characters and seven digits
also takes the seven-digit ones. Other branch codes are not claimed until numbers show them;
the adapter takes any three letters and six to nine digits.

## Links

The page also reads the AWB from its address, so
`makati-express.com/tracking/?awbnumber={number}` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/makati-express`, with `MAKATI_EXPRESS_TRACKING_NUMBER`
and optionally `MAKATI_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
