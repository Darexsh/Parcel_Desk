# A. Duie Pyle

A. Duie Pyle is a less-than-truckload freight carrier in the northeastern United States. It hands
freight bound beyond its network to partner carriers. Tracked through the lookup its shipment
status page makes.

## How it works

1. `direct`: one `GET https://aduiepyle.com/wp-json/adp/2/shipment/status?type=0&value={PRO}`,
   as the page at `aduiepyle.com/resources/shipment-status/?tracking={PRO}` makes it. It needs
   no cookie, token, key or browser. The JSON reply holds the shipment's status, its parties and
   its history oldest first.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A PRO it does not know is HTTP 200 with a result that holds the number and `We are unable to
  find this shipment.`, which the page shows. Any other empty answer, or one for another PRO, is
  inconclusive. A 404 or a redirect is a moved route.
- The adapter asks by whole PRO (`type=0`) only; the page's searches by other references are
  not used.
- Recognition makes the same request.

## Notes

- Each row gives a wall clock in `start` and `end` and an offset in `startUTC` and `endUTC`.
  The offset is kept only where it is the one the row's place keeps at that instant, in a state
  that keeps one zone throughout. A clock labelled with another zone's offset, one in a split
  state or Canada, and one without a place stay wall clocks in `local_time`.
- A clock at midnight is a day without a time, as in pickups.
- The pickup, delivery appointment and ETA windows are rows of the history, listed after the
  scans; they are not scans. The estimate is the one the page shows: the latest ETA window, else
  the delivery appointment window, else the day the shipment is due. A window whose offsets are
  not kept gives its days.
- A delivery row spans the stop; the page shows its end as the delivery, and so does
  `delivered_at`. A scan recorded after a delivery does not undo it. `INVOICED`, the status that
  follows a delivery, moves nothing.
- The weight is in pounds without a unit.
- A shipment handed to Dayton Freight, Southeastern Freight Lines or Oak Harbor, the partners
  the page links, names that partner and its PRO.
- The reply names the shipper, the consignee and the paying customer with their addresses, and
  holds the bill of lading, the purchase order, a delivery comment and the piece count. None of
  them is read.

## Limitations

- No service, sender, recipient, signature or delivery receipt.
- A PRO reaches the adapter when it is filed under A. Duie Pyle or opened from an A. Duie Pyle
  link: eight and nine digits are shared by many carriers, so no rule claims them and preflight
  does not ask it.
- Offsets are kept only for places in single-zone states.

## Numbers

A. Duie Pyle tracks freight by its PRO number, which its tracker requires to be eight or nine
digits. Lookups archived from its shipment status page show nine-digit PROs; the samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The shipment status page reads a PRO from `?tracking=` on
`aduiepyle.com/resources/shipment-status/` and looks it up straight away. The library reads the
number from that address.

## Testing

`npm run test:carriers:live -- carriers/a-duie-pyle`, with `A_DUIE_PYLE_TRACKING_NUMBER` and
optionally `A_DUIE_PYLE_UNKNOWN_NUMBER` set outside the repository.
