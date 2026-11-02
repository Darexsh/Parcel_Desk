# GEODIS Poland

GEODIS's Polish road network (GEODIS Road Network, called PEKAES until its rebrand), tracked
through its own tracker at `strefaklienta.pekaes.geodis.pl`. GEODIS France's recipient lookup is
the separate [`geodis`](../geodis/README.md) carrier.

## How it works

1. `direct`: two anonymous `GET` requests to the English page, with no cookie, form token or key.
   - `/en/?ShNumber={number}` answers the same search the page's form posts with its
     `REQUEST_TOKEN`. The reply is the search page with a summary of the shipment, or a notice.
   - `/en/?ltlHistory={number}` is the request the summary's "Details" link sends. It returns
     the scans as JSON rows, or `null` when the shipment has none yet.
2. `retry`: one more try when a request fails to reach the site or hangs. The first try gets
   half of the budget.

- Only `PL` and sixteen digits are looked up.
- The summary must name the number asked, and so must its history link; another shipment is
  inconclusive. The history does not echo the number, so the summary is read first.
- "Shipment with such number does not exist" is not found, and a refused input is invalid. Both
  count only when the search field echoes the number asked. Redirects are not followed, and a
  moved or missing page is a transport failure.
- Recognition makes the same requests.

## Notes

- The page script labels each scan code in the page's language. The adapter reads the English
  page and uses its labels, because the history's own wording has typos and follows the
  language. A code the script does not label keeps the history's wording.
- The history gives wall clocks without an offset, and the page appends a fixed `+0100` for
  display only. Read as UTC or as UTC+1, a scan made just before a read would fall after it. As
  Warsaw summer time it falls just before. Scans at Polish terminals (branch codes starting with
  `PL`) are therefore read on Warsaw time. A terminal abroad keeps its wall clock.
- A pseudo-scan (code 300) cancels the delivery, return and claim scans before it, as the page's
  label says. The adapter drops it together with them. A claim (500) records a complaint and
  keeps the stage the shipment had. It never decides the status.
- Identical rows, which a shipment of several items can repeat, become one scan. A scan dated
  over an hour after the read is held back.
- A shipment without scans gives the summary's status alone.
- The summary also shows terminals, dates, the shipment type, the item list and the delivery
  postcode and town. The adapter reads only the status and the delivery country. The history's
  remarks, which can name who signed, are never read.
- Neither reply names a partner or its number, so there is no hand-off.

## Limitations

- No delivery estimate, weight, service name, sender, recipient or proof of delivery.
- Scans at terminals abroad have no established zone.

## Numbers

Shipment numbers are PL and sixteen digits, the number the tracker shows as the shipment's and
sellers give as its waybill. PL is the country, not the carrier, so the rule has low confidence
and recognition asks the tracker.

## Links

The tracker opens one shipment at `strefaklienta.pekaes.geodis.pl/?ShNumber={number}`, with or
without a language such as `/en/` in the path. The library reads the number from those links.

## Testing

`GEODIS_PL_TRACKING_NUMBER=... GEODIS_PL_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/geodis-pl`
