# Fixtures

The pages follow the AWB History page on `www.erpfranchexpress.com/api-tracking.php`, cut down to
its tracking form, the heading that names the number, the list of scans newest first, the
images table and the form's script.

- `delivered.html` is a consignment handed to a partner and delivered. Its partner waybill is
  not of a shape the partner issues. It has a repeated forwarding scan, a scan just after
  midnight, a hold with its reason, a delivery that names who took the parcel with a phone
  number, staff names on every scan and a proof-of-delivery link.
- `in-transit.html` is a consignment between hubs, last forwarded to Blue Dart with a waybill of
  Blue Dart's shape.
- `not-found.html` is the page's answer for a number it has no consignment for, which does not
  name the number.

The lookup's token, a browser check and the other failures are built inline in the tests.

Numbers, names, phone numbers, hub codes, places and clocks are invented.
