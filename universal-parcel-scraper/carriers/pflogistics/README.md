# Parcel Freight Logistics

PFL's Australian parcel service is read from its [public tracker](https://pflogistics.com.au/tracking).
Air cargo and PFL Logistics of Indiana are separate services.

`direct` requests `/tracking-result` with the whole reference in `tracking` and
`timezone=UTC`. The server renders the latest scan and expanded history without a cookie,
CSRF token or CAPTCHA; the form's POST has an equivalent guest GET. `retry` repeats only a
network failure within the lookup budget. HTTP recognition uses the same dated history and
the carrier's exact missing-number notice.
Rejected HTTP pages stay out of error diagnostics because they can contain parcel details.

The timezone parameter converts every scan, including those from depots in different
Australian zones. UTC is requested explicitly; an offset printed on a scan is preserved.
The detailed wording distinguishes pickup from depot processing under their shared heading.
The progress rail is not used as history.

Only the reference family in `carrier.json` is accepted. Its forwarding prefix does not
establish ownership: the result must name the whole reference and contain dated PFL scans.
Other forwarding prefixes and air waybills are unsupported. The page exposes milestone
scans without an estimate or delivery-partner reference.

Run `npm run test:carriers:live -- carriers/pflogistics` with
`PFLOGISTICS_TRACKING_NUMBER`, optionally `PFLOGISTICS_SECOND_TRACKING_NUMBER` and
`PFLOGISTICS_UNKNOWN_NUMBER`.
