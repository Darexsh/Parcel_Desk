# Shiprocket

Shiprocket is an Indian shipping platform: merchants book their parcels with couriers through
it and send their buyers its tracking page. ShiprocketX (SRX) is its cross-border service, which
carries a parcel from the merchant in India to a buyer abroad under Shiprocket's own AWB.
Tracked through the tracking page Shiprocket serves for an AWB.

## How it works

1. `direct`: one `GET https://shiprocket.co/tracking/{awb}`. It needs no cookie, token, account
   or browser. The HTML page is the merchant's tracking page: the shipment's status, the
   courier or service, the AWB, the order's day and the rows newest first, each with an
   activity, often a place, a day and month, and a twelve-hour clock. While the parcel is not
   delivered, one `GET https://apiv2.shiprocket.co/pocx/tracking-order-edd/{order id}` follows
   for the delivery estimate, as the page's script asks for it, by the order id the page holds
   in a hidden field. An estimate that fails or says nothing leaves the history without one.
2. `retry`: one more try when the page's request fails to reach the site or hangs. The first
   try gets half of the budget.

- The page counts only when the AWB it holds and shows is the one asked.
- An unknown AWB is HTTP 400 with Shiprocket's "AWB Not Found" page: not found. That page under
  another status, another HTTP 400, a redirect and a missing route are not.
- A bot check in place of the page is a challenge. The page loads reCAPTCHA for its own buyer
  forms, which is no check.
- Recognition reads the page alone, without the estimate.

## Notes

- Merchants keep one of two page templates, which label the rows and name the courier in
  different markup; both are read.
- The rows name no year and no zone. The order's day, which the page gives with its year,
  sets the year: rows come after the order. Without it, the year is the latest that puts the
  row no later than the day after the read. Rows dated after the read are dropped.
- Shiprocket keeps India's clock: its estimate comes as a date in `Asia/Kolkata`, and its order
  row is written at midnight of the order's day. Rows on India's clock are those of a courier
  that delivers only within India, such as Delhivery or Blue Dart, rows placed in an Indian
  state, as the domestic courier's hubs are ("Gurgaon_Hub (Haryana)", "DELHI"), and
  Shiprocket's own order and export hub rows.
- ShiprocketX rows abroad keep their wall clock: they come from the destination's carrier or a
  transit hub, and the page names no zone for them. Unplaced rows of another partner, such as
  USPS's pre-advice, keep it too.
- A row at midnight gives its day only.
- The order's row is placed at the buyer's town, so its place is left out.
- The domestic courier's wording is kept as it comes. "Manifested - Out for Pickup" is a
  pickup still to come, and "Dispatched - Delivering At Shiprocket Warehouse" takes a
  ShiprocketX parcel to Shiprocket's export hub, not to the buyer. The export hub's rows,
  such as "Received At DC" and "AWB Handed over to Flight", are transit, not the first
  acceptance. Wording that starts with RTO, return to origin, is the way back to the merchant.
  The map in `statuses.json` stages the rows seen, and other rows fall to the shared wording
  rules.
- The service the page names beside the AWB, such as "SRX Economy", is the service name.
- An older shipment's page is an archived view: its last status, the day of that status, its
  service and its AWB, without rows, which only the buyer sees after a code sent to their
  phone. It is read as a summary without history. After about a year the AWB is not found.
- The merchant, the order's reference and contents, the buyer and the map of the delivery
  address are never read.

## Limitations

- No proof of delivery, weight, sender or recipient.
- A ShiprocketX delivery abroad has a wall clock, so it gives no delivery time.
- An archived view gives no history.

## Numbers

ShiprocketX's AWBs are 13 digits starting `832`, as archived tracking pages and Shiprocket's
API documentation show them. No other 13-digit AWB in archived links to Shiprocket's tracker
starts `832`; Delhivery's and Xpressbees' use other prefixes. `shiprocket-1` claims that shape
as a preferred low-confidence rule, since Delhivery's waybills share the length and its
prefixes vary by client. The tracker also answers other couriers' AWBs, so a link to it names
Shiprocket whatever the number.

## Testing

`SHIPROCKET_TRACKING_NUMBER=... SHIPROCKET_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/shiprocket`
