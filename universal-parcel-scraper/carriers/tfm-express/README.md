# TFM Express

TFM Express is a Dubai courier that delivers across the UAE and ships to the other Gulf states
and Iraq. Tracked through the tracking page its site frames.

## How it works

1. `direct`: one `POST https://customer.tfmex.com/Skybill/TrackSkybill` with the form body
   `AWB={number}&clientTimeZoneOffSetHour=0`, as the page's form sends it. No key, cookie,
   captcha or browser is needed. The server renders the shipment's summary and its history,
   newest first, under the form.
2. `retry`: one more attempt when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- An unknown airwaybill is HTTP 200 with "Shipment Not Found", which is not found. A page with
  neither a shipment nor that notice is a changed page. A 404 or a redirect is a moved route.
- The form also carries an anti-forgery field and a fixed key, which the page does not check: a
  post without them, or without the cookie the page sets, answers the same. A refused form
  would mean the site started to check them.
- The tracker matches the whole airwaybill only, without trimming spaces. The summary must name
  the airwaybill asked.
- Recognition makes the same request.

## Notes

- The form's script posts the browser's UTC offset in hours, and the page adds it to every
  clock, by the half hour as well. Its clocks are therefore UTC. The adapter posts 0 and returns
  each row as an instant at Dubai's offset, to the minute.
- Each row has a status name, such as `Received at HUB`, and an activity line, often empty. The
  status name is the row's provider code and stages it; the activity, or the status name when
  there is none, is its description. The summary's steps repeat the history's status names and
  are not read.
- The page shows no place, weight, service, sender or recipient. Activity lines lose phone
  numbers.

## Limitations

- No estimate and no locations.
- The tracker's search by the sender's reference is not used.

## Numbers

TFM Express airwaybills are twelve digits. Twelve-digit runs are shared with FedEx and other
carriers, so no rule claims them and the gap is declared; preflight does not ask TFM Express.
The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`https://customer.tfmex.com/Skybill/TrackSkybill?awb={number}` opens the page, whose script
fills the airwaybill in and posts it.

## Testing

`npm run test:carriers:live -- carriers/tfm-express`, with `TFM_EXPRESS_TRACKING_NUMBER` and
optionally `TFM_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
