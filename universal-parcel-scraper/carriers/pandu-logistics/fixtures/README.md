# Fixtures

Each file follows the reply of the tracking page's `admin-ajax.php` lookup: the tracking
service's decoded answer under `json`, its raw answer and status under `request`, the page's
rendering under `html` and the request's fields under `raw`. `delivered.json` is a POD number
from origin to delivery, oldest scan first, with one branch arrival repeated, the receiver's
name in the delivery scan and the summary, and the sender's and the consignee's names, cities,
postcode and contents. `in-transit.json` is an AWB number with letters, which has reached the
destination branch and whose summary status is still `NOT AVAILABLE`. `not-found.json` is the
answer for a number the service does not know: an empty answer and the page's notice.

Numbers, names, places, postcodes, contents and clocks are invented.
