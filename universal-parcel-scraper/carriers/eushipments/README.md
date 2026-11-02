# euShipments

euShipments is a Bulgarian fulfilment and e-commerce delivery company that ships online shops'
orders across the European Union and the United Kingdom through its own hubs and local couriers.
Tracked through the form handler of its tracking page.

## How it works

1. `direct`: one `POST https://eushipments.com/wp-admin/admin-ajax.php?action=track_order_form`
   with `tracking_number={number}`, as the tracking page's form sends it. It needs no cookie,
   token, key or browser. An order comes back as a piece of HTML: a heading that names the
   number searched, a table of statuses, oldest first, and, once a courier has the parcel, the
   courier's name, number and tracking link.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A number the tracker does not know gets the JSON error `Order with this number not found`,
  read as not found. Its other errors, such as an empty number, leave the answer open.
- The handler answers every number with HTTP 200, so a redirect, a 404 or a 400 is a moved
  route, and a firewall page is a challenge.
- The heading must name the whole number asked.
- Recognition makes the same request.

## Notes

- Each status has an English wording of euShipments' own and the courier's wording beside it.
  The English wording is kept: it is the same for every courier. The courier's wording is not.
- Warehouse and hub statuses name the place after the wording, and hubs add their country, so
  the place is kept as the location and the map reads the wording without it.
- Status clocks are wall clocks to the minute with no zone, so they stay `local_time`.
- The courier the tracking link's address names becomes the delivery carrier, with the
  courier's number when it differs from the one asked. A name without such a link names none:
  euShipments' couriers include companies that share a name with another country's carrier.

## Limitations

- No instants, scan codes, expected delivery or proof of delivery.
- An order whose courier the catalog does not know has no delivery carrier.

## Numbers

euShipments shows an order under the number the shop sends its customer, which can be the
courier's own number. The one public number seen is eight digits, the Bulgarian courier's
number. No rule claims it: many carriers print eight digits.

## Links

The tracking page takes the number only in its form, so no address opens one order.

## Testing

`npm run test:carriers:live -- carriers/eushipments`, with `EUSHIPMENTS_TRACKING_NUMBER` and
optionally `EUSHIPMENTS_UNKNOWN_NUMBER` set outside the repository.
