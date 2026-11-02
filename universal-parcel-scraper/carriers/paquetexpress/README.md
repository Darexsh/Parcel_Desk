# Paquetexpress

Tracks Paquetexpress parcels in Mexico through the history service behind Paquetexpress's own
tracker.

## How it works

The tracker at `www.paquetexpress.com.mx/rastreo/{number}` asks
`cc.paquetexpress.com.mx/ptxws/rest/api/v1/guia/historico/{number}/{token}?source=WEBPAGE` for the
parcel's history. The token is a fixed value the page and the Android app send for every visitor;
no account, cookie, CAPTCHA or browser is needed. The adapter sends one GET with an ordinary
`Accept` header, which the service needs, and does not follow redirects. A request that fails to
reach Paquetexpress is sent once more within the budget.

The reply is a JSONP call, `Resultado([...])`, around the rows of the history, oldest first. An
unknown number gets an empty list, which is the only missing parcel. A refused token gets one
`ERROR DE ACCESSO` row and stays inconclusive, as do redirects and HTTP 404. Rate limits and other
HTTP errors keep their own failure kinds. Recognition uses the same lookup.

The page first asks the service's latest-event route and then the history; the Android app asks
the history alone, as the adapter does, since its rows carry the same fields.

## Numbers

Tracking codes are eleven to thirteen digits, and the adapter takes ten to fourteen.
Paquetexpress publishes no layout or check digit for them, and other carriers share each of those
lengths, GLS and PostLogistics among them, so detection does not offer Paquetexpress for a code;
tracking one runs when the caller names the carrier. A guía is the issuing branch's code, three
letters and two digits as the service names its branches, then two letters and a sequence.
`paquetexpress-1` offers Paquetexpress for a guía at low confidence, so preflight asks
recognition. The rule takes the five to seven digits seen in sequences, the adapter four to nine.
Other shapes are invalid without a request.

The service also matches shippers' references and answers with the parcels they belong to. Rows
count only when their tracking code, or their guía, is the number asked; any other parcel is
inconclusive. A guía covers every parcel on it, and a delivered parcel does not settle one still
on its way.

## Notes

- Rows carry a code, Spanish wording, the scanning branch's town and two clocks. Codes are mapped
  in [status.ts](status.ts); other codes go to the shared wording rules. A cancelled pickup request
  moves nothing, and the rows the tracker hides are dropped. A parcel the recipient collects at
  the branch waits for pickup once its destination branch receives it.
- The wording names people: the user who made a web-services label after "POR", the sender a
  driver collected from after "A", and whoever took the delivery after ", recibió". The adapter
  cuts each wording before them, and cuts unmapped wording at the first such word or comma.
- The backend stores each scan on central Mexico's wall clock and returns it as an epoch stamp
  read at UTC-6, so stamps from before Mexico ended daylight saving time are an hour late. The
  adapter reads the stored clock in Mexico City's zone for the instant. The row's `hora` is the
  branch's clock, a whole number of hours from central time, and sets the offset each scan is
  shown with; the printed date can be a day off, so the date comes from the stamp.
- The estimated day is shown until the parcel is out for delivery, or while it is out for delivery
  when the shipper asks the tracker to show it, as on the tracker. It is dropped once the parcel
  waits at its branch or is delivered, and once a later day's scan has come.
- The rows also carry the shipper's reference and the recipient's city, and the page shows the
  signature, the delivery receipt and the branches' addresses from other routes. None of them is
  read; scans are placed in the scanning branch's town.

## Limitations

Shippers' references are not tracked.

## Links

The search form opens `www.paquetexpress.com.mx/rastreo/{number}` (`/en/rastreo/{number}` in
English), which shows one parcel; the library reads the number from such a link and builds it.
Several numbers searched at once are joined with hyphens in one address, and the library leaves
those alone.

## Live test

Set `PAQUETEXPRESS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/paquetexpress/adapter.live.test.ts`.
Optionally set `PAQUETEXPRESS_UNKNOWN_NUMBER` to check a number Paquetexpress does not know.
