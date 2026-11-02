# GO! Express

Tracks GO! Express & Logistics waybills, the courier and overnight express network in Germany,
Austria, the Czech Republic, Denmark, Luxembourg, the Netherlands, Poland and Slovakia, through
the service behind GO!'s own tracking pages.

## How it works

Every GO! country has its pages on `www.general-overnight.com` (the national domains redirect
there), and each country's tracking page posts its search to `/api/v2/tracking`. The form body
is one field, `q`, holding base64 JSON with the waybill, the page's country and its language.
The service answers with the HTML fragment the page inserts. The adapter sends Germany's
English search with one POST. No account, cookie, key, postcode, CAPTCHA or browser is needed.
A request that fails to reach GO! is sent once more within the budget.

The reply names the shipment's waybill and links to its tracking page; both must match the
requested waybill. A waybill the service has no shipment for gets "We have not yet received
the shipment with the specified tracking ID", which is a missing shipment only when its link
carries the requested waybill. The service gives that notice for any input, so it says nothing
about the number's shape. Other notices, block pages, redirects and HTTP errors keep their own
failure kinds. Recognition uses the same lookup.

The page asks for the recipient's postcode to show detailed delivery information. The history
does not need it, and the adapter never sends one.

## Numbers

GO! waybills have twelve digits, and the adapter takes only that shape. GO! publishes no layout
or check digit, and twelve digits are shared with FedEx, GLS and many other carriers, so no rule
claims them and the user picks GO! Express. Preflight therefore never asks GO! about a number.

## Notes

Rows carry a wording, a day, a clock and the station or hub, newest first. The wording has no
code; the map reads it in English and in German, the network's own wording, and wording it does
not know goes to the shared rules. A row the page marks as an error and nothing else stages is
an exception. The page can list a delivery twice at the same minute, and packages travelling
together share their scans, so identical rows are kept once.

Clocks are the stations' wall time without an offset, and every GO! country keeps Central
European time, so they stay local times. The page's progress rail and the responsible station's
name, phone and email are not read. The Polish page uses an older layout that names the pickup
and delivery towns; the adapter asks for the German site in English, which does not.

## Limitations

Shipments leave the tracker a few months after delivery, and it then gives the not-found
notice. The page has no estimated delivery date, weight or service. GO!'s Android app
(`com.generalovernight.express`) reads GO!'s web-service API on `ws.api.general-overnight.com`;
the public page needs no credentials, so the app's route is not used.

## Links

GO!'s tracking pages, one per country and language, take the number as `reference` and render
the shipment on the server. The German page's own permalink opens one shipment at
`/deu_de/versenden/sendungsverfolgung.html?reference={number}`, and archived lookups used the
same parameter on the former `/deu_de/sendungsverfolgung.html` and on the Danish English page.

## Live test

Set `GO_EXPRESS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/go-express/adapter.live.test.ts`.
Optionally set `GO_EXPRESS_UNKNOWN_NUMBER` to check a waybill GO! does not have.
