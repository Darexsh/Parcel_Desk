# ATS Healthcare

ATS Healthcare (Andlauer Transportation Services) is a Canadian healthcare courier with branches
in every province, part of UPS Healthcare since UPS bought its parent in 2025. Its site is
atshealthcare.ca.

## How it works

1. `direct`: one `GET https://www.atshealthcare.ca/quickTrackResult?ship={number}`, the result
   page its quick-track form opens. It needs no session or browser.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try
   gets half of the budget, so the retry fits in the rest.

- A number the tracker does not hold gets a placeholder row, `Shipping label created for ATS
  Healthcare`, and `No detail for shipment` with the number in place of the progress bar, read
  as not found. A redirect or a 404 is a moved route, a firewall page is a challenge and a 429 is
  a rate limit.
- The row and the detail must carry the whole number asked.
- Recognition makes the same request, and only for a caller in Canada.

## Notes

- The page has no history: a status with a wall clock to the second and no zone, and a
  progress bar from `On file` (0) to `Delivered` (6). The bar's step is the provider code and
  gives the stage; the status gives the text and the time, which stays `local_time`.
- The signatory is not read. The page's `Select` link reloads the same page.

## Limitations

- A summary only: no history, places, instants or expected delivery.
- The placeholder is all the tracker shows for any number it has no detail for, so a shipment
  in that state reads as not found.

## Numbers

Its shipment numbers are eight or nine digits, lengths many carriers share, so there is no rule.

## Links

The result page opens a number from its `ship` parameter.

## Testing

`npm run test:carriers:live -- carriers/ats-healthcare`, with `ATS_HEALTHCARE_TRACKING_NUMBER`
and optionally `ATS_HEALTHCARE_UNKNOWN_NUMBER` set outside the repository.
