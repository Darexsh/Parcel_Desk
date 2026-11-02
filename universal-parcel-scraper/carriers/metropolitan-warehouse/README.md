# Metropolitan Warehouse & Delivery

Metropolitan Warehouse & Delivery is a US carrier that collects furniture and other large
items from vendors and delivers them to homes. Tracked by its twelve-digit tracking number
through the requests the tracker on gomwd.com makes.

## How it works

1. `direct`: three GETs on `https://main.gomwd.com`, the ones the tracker's script makes.
   `/Client/CheckTrackingId?trackid={number}` answers whether the tracker holds an order under
   the number. `/Client/TrackOrderWix_encryptUrl?trackingid={number}` answers with the path of
   the order's page under a key the tracker issues, and that page holds the history in its
   script's `historyTrans`. None needs a cookie, token or browser.
2. `retry`: one more attempt after a failed connection or a timeout. An HTTP status is never
   sent again.

- Only the check's `Tracking id does not exist.` is a missing order; any other refusal is
  inconclusive. The link answers for any number and the order's page fails with HTTP 500 for a
  number the tracker does not hold, so the check comes first.
- The tracker page asks for a captcha in the browser before it checks the number. The check
  itself carries no captcha answer.
- The order's page must show the whole number asked. A firewall page in place of a reply, even
  with HTTP 200, is a challenge; a redirect or a missing route is a moved tracker.
- Recognition sends the check alone. Its answer has no date, so a known order has no last
  activity.

## Notes

- Clocks are wall clocks without an offset, so they stay `local_time`. The page names a display
  zone, Central time, and an older version of it named Eastern time; it is a setting of the
  page, not the place of a scan, so no offset is derived from it. The catalog names Central.
- A row's stage comes from its event code. The paperwork code and the delivery appointment's
  codes move nothing; a code the map does not know takes the shared wording rules.
- The tracker writes the receiving hub as `Metro-<Warehouse>-Hub`, a placeholder it leaves
  unfilled; the event reads `Metro-Hub`. A row placed `In Transit` names no place and gets
  none.
- The service level, such as Room of Choice, and the weight, given in pounds, are kept. The
  page also names the destination town and postcode, the order's and the client's references,
  the delivering partner's PRO number, the item count and their volume. None of them is read,
  and the key in the page's address is not kept.

## Limitations

- No estimate, no delivery partner and no clock with an offset.
- Only the history is read, not the progress steps the page draws above it.

## Numbers

The tracker's script takes twelve digits and refuses anything else before it asks. Many
carriers share twelve digits, so `metropolitan-warehouse-1` suggests Metropolitan at low
confidence among them and recognition asks the tracker whether it holds the order. A US
caller asks it first; otherwise the commoner twelve-digit carriers are asked before it.

## Testing

`npm run test:carriers:live -- carriers/metropolitan-warehouse`, with
`METROPOLITAN_WAREHOUSE_TRACKING_NUMBER` and optionally `METROPOLITAN_WAREHOUSE_UNKNOWN_NUMBER`
set outside the repository.
