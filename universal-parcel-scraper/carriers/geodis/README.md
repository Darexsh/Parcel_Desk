# GEODIS

French express and distribution network. Covers the anonymous recipient lookup ("Espace
destinataire") for French last-mile `1G…` shipments. Freight and account portals are out of
scope.

France Express, the GEODIS group's network of express agencies, has the same recipient app at
espace-client.france-express.com, with the same interface behind it, so its name and links route
here.

## How it works

1. `direct`: one bounded signed
   `POST https://espace-client.geodis.com/services/api/destinataire/recherche-envoi-anonyme`
   with the exact body `{"noSuivi":"…"}`. No session; the signature replaces a browser.
   - `X-GEODIS-Service` is `appId;timestamp;language;sha256(appKey;appId;timestamp;language;apiPath;body)`,
     as the recipient SPA computes it. A fixed-timestamp unit test covers the scheme.
   - `ok: false` with a "envoi non trouvé" `codeErreur` is not-found. Any other `ok: false`
     is `IndeterminateError`: a technical rejection does not prove the shipment is absent.
   - `contenu.noSuivi` must equal the requested number.
   - Events come from `listJoursSuivis[].suivis[]`, de-duplicated on time, location and
     description, newest first, capped at 100. A delivered shipment's reply can come without
     them, with only the timeline step; the result is then `summary_only`.

## Notes

- `PUBLIC_SPA_APP_KEY` is a public client identifier shipped in the recipient SPA, not an
  account secret. It can rotate when GEODIS deploys the frontend; requests then fail loudly.
- `GeodisTrackingError` is a plain `NotFoundError` kept as a named class because
  `testing/frenchDirectCarriers.live.test.ts` matches on its name.
- Status is wording-only (no codes). Rule order matters: "en cours de livraison" and "va être
  livré" contain the participle, so out-for-delivery and future-delivery rules run first, and
  delivered rules are anchored (sentence start, "a été livré", or a parcel noun before it).
- Unmapped wording keeps its text and gets no stage, so the sync classifies it.
- The active timeline step's label is the current status text and sets the current stage,
  falling back to the newest scan whose wording is mapped. The steps follow the delivery
  route, and the page only turns the current one red when the recipient has to act, so a
  newest scan reporting a missed delivery, a problem, a return or a parcel held for
  collection wins over the step. Terminal booleans override the wording: `etatLivre` /
  `etatRetire` force `delivered`, `finDeVie` forces `exception`, or `returned` when the
  wording says so. `finDeVie` alone is not `returned`: it also covers write-offs and
  closures. The estimate is dropped once any of them is set.
- The endpoint gives each day and scan clock as a display string without an offset. A scan
  keeps them as an ISO wall clock in `local_time`, or its day alone, which Node lookups date
  on Paris time or the scan's place. A UTC-based number is used only as a sort key.
- Read: status, timeline, `libelleCentre` (location), the planned date, the sender's name
  (`expediteur.nom`, which the page prints after "Envoyé par"), the weight (`poids`, which
  the page prints in kilograms) and the service (`prestationCommerciale.libelle`, which the
  page prints after "Prestation"). When the name is empty the page shows the sender's contact
  person instead; that is a person, so it is not read. The rest of the sender block, the
  recipient block, `listInformationsComplementaires` (free-text access instructions) and
  delivery documents are never retained; a test asserts it.

## Testing

`npm run test:carriers:live -- testing/frenchDirectCarriers.live.test.ts` (no env vars). It
asserts a validly shaped unknown `1G…` number returns not-found.
