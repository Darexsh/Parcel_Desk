# DPD France

DPD France (formerly Exapaq), French last mile only. Tracked by parsing the
server-rendered recipient trace page. DPD Switzerland is a different protocol
in [`dpd`](../dpd/README.md).

## How it works

1. `trawl`: with a browser service (`FLARESOLVERR_URL`), its `scrape` API
   (`skipHttp`, `maxTier: 3`) loads `https://trace.dpd.fr/fr/trace/{number}`.
2. `direct`: without one, a GET of the same page with a browser-like
   `User-Agent`, 20 s timeout. A 403 with `cf-mitigated: challenge` or a "Just
   a moment" page is a Cloudflare challenge, which says "configure
   FLARESOLVERR_URL".
3. `retry`: that GET once more after a network failure or timeout. Until
   then `direct` gets at most half of the time left, so a GET that hangs
   leaves time for it.

Both tiers return HTML for the same parser. "Numéro de colis inconnu" (or "pas
en mesure de retrouver") with no parcel number on the page is not-found. Other
non-2xx statuses are indeterminate.

## Notes

- Detection: `250` + 12 digits selects DPD France. Other numbers starting with
  0 or 1 (12–15 digits) are suggestions; 14-digit numbers from the ex-Exapaq
  depots 10xx list DPD France first (DPD's published depot table and the
  published integration example), without selecting it.
- Labels print the `250` number with a GS1 check digit as a sixteenth digit, and
  links often carry that form. When the check digit matches, detection lists DPD
  France first and the adapter looks the parcel up by its fifteen digits, the
  number the trace page shows. Other sixteen-digit numbers are refused.
- With a browser service the plain GET is skipped: Cloudflare challenged every
  one, from a server and from a home connection alike, so it only added a
  failure before each browser lookup. Without one it is the only way to ask.
- One page can show an outbound parcel (`#infos1`, `tr.tabTraceColisAller`) and
  its return (`#infos2`, `tr.tabTraceColisRetour`). The requested number picks
  the leg; the other leg's rows are never read. A page without the requested
  number is a `SchemaError`.
- No status codes, only French prose, compared lowercase without accents or
  punctuation (DPD varies them between rows; a spacing accent such as
  "l´expéditeur" counts as an apostrophe). Earlier trace pages used shorter rows
  ("Colis livré", "Colis en livraison", "Colis en agence DPD France"); both
  styles are mapped.
- Rule order matters: returns, then incidents, then delivery. "votre colis sera
  retourné à l'expéditeur" would otherwise match a delivery rule, and "nous
  avons reçu une réclamation" would look like movement.
- "retard" maps to `failed_attempt`; "réclamation" and "enquête est ouverte" to
  `exception`.
- Unrecognized wording keeps the row with no `stage`; the result status comes
  from the newest recognized row. `statusMap` in [status.ts](status.ts) answers the app's
  review queue by the same wording.
- The fourth cell is the depot or sorting centre. The delivered row puts "Livré au
  destinataire" there, which is no place, so that row has no location. The app's
  scan-identity policy lets the row stored with it keep its identity, provided its
  instant, wording and known stage agree.
- The depot tab names the delivering depot ("Etablissement 067") and carries its map marker.
  Rows naming the same depot number ("Agence DPD de Strasbourg (67)") get that marker as
  their `point`: the depot is in Bischheim, 6 km from Strasbourg's centre. Other depots
  have no point, and the depot's street address is never read.
- Rows print naive `dd/MM/yyyy` + `HH:mm` in two cells, read in Europe/Paris.
  The planned delivery date is a calendar day, dropped once delivered or in
  exception. `delivered_at` is the newest delivery row of a delivered parcel.
- "Poids du colis" in the details block, when the page lists it, is the weight.

## Rejected approaches

- A JSON feed behind the page: there is none; the timeline exists only as
  markup.
- The myDPD app (`com.dpdgroup.chatbot.lemny.prod`): its guest lookup is the DPD
  Group service the [`dpd`](../dpd/README.md) adapter already reads,
  `POST https://www.dpdgroup.com/concept/webservice/v10/parcels/details/{number}`
  with a `businessUnit`. The app lists `DPD-FR` among its business units but
  sends French parcels to the website, and Cloudflare blocks the call for that
  unit. Without a postcode the service also returns less than the trace page.

## Limitations

- DPD France's site terms restrict unapproved automated access. Treat this as
  experimental; a contracted API is the long-term fix.
- Customer reference, delivery address and proof-of-delivery blocks are never
  read: the parser visits only timeline rows, labelled detail rows and the depot
  tab's first line and marker.

## Testing

`npm run test:carriers:live -- testing/browserProtectedCarriers.live.test.ts`
runs without a browser service, so it accepts either a clean not-found or the
challenge error.
