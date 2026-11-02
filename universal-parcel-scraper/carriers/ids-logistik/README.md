# IDS Logistik

IDS is a German general-cargo network whose regional partners collect and deliver, including
bulky online orders such as furniture and bicycles. Its shipments are tracked by number and the
recipient's postcode through the lookup behind its tracking page.

## How it works

1. `direct`: one `POST https://www.ids-logistik.de/api/shipping/status` with
   `{"trackingNumber":number,"zipCode":postcode}`, as the tracking page sends it. It needs no
   cookie, token or browser. The JSON reply echoes both and holds the shipment's scans, the
   depots that collect and deliver it, and the step of the page's progress rail.
2. `retry`: one more try when the request fails to reach IDS or hangs. The first try gets
   half of the budget.

- The postcode is required: without it the lookup fails with HTTP 500.
- A shipment IDS has no data for under that number and postcode comes back with no scans, no
  header id and status 0, which the page explains as no information yet: `NotFoundError`. A
  wrong postcode gets the same answer. Before reporting it, the adapter reads the maintenance
  flag the page reads, `/api/maintenance/state`; a raised flag is maintenance. An empty
  `result` list or an error the reply reports is inconclusive.
- The reply must echo the number and postcode asked.
- The depots' towns come from the partner list the page reads, `/api/ids/partner`, kept for
  six hours. Scans have no town while the list cannot be read.
- No recognition: every lookup needs the postcode.

## Notes

- The page names a scan by its status code, with a sentence from its messages file, or else by
  its `mp` code, and then only at the depot that code belongs to: the pickup at the collecting
  depot, the arrival and the delivery at the delivering one. It hides every other scan, and
  shows only the older of two equal sentences less than five minutes apart. The adapter does
  the same, with the page's German sentences. A delivery appointment is filed at the
  delivering depot, as the page files it.
- The page adds a scan at the collecting depot when the shipment goes on a linehaul manifest
  (`header.bordered`), and so does the adapter.
- A shipment without a scan the page shows is at the rail's first step, "Daten übermittelt.",
  and comes back as a summary. A rail at its last step settles a delivery the scans have not
  reached.
- Clocks are wall clocks without a zone, read in Germany's time.
- Each scan's free text, the weight, the sender's and recipient's towns and postcodes in the
  header and the partners' contact details are never read.

## Numbers

IDS's tracking form takes a Sendungsnummer of 13 to 16 digits together with the recipient's
postcode. A Trustpilot review and an archived lookup on IDS's own tracking service show
sixteen-digit numbers. Sixteen digits are shared by several carriers, so no rule claims them.

## Links

The form opens `ids-logistik.de/de/sendungsverfolgung` with `trackingNumber` and the
recipient's postcode as `zipCode`; the page shows nothing without the postcode, so no address
opens one parcel from the number alone. Only the number is read from such links.

## Limitations

- Nothing can be looked up without the postcode, and a wrong postcode reads as not found.
- No delivery estimate, signatory or proof of delivery.

## Testing

```sh
IDS_LOGISTIK_TRACKING_NUMBER=... IDS_LOGISTIK_POSTCODE=... IDS_LOGISTIK_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/ids-logistik
```
