# Poste Italiane

The Italian postal operator. Tracked through the keyless DoveQuando REST endpoint behind the
`poste.it/cerca` tracker. Dutch handoffs of Poste Italiane consignments stay with
[PostNL](../spring-gds/README.md). SDA parcel shapes are recognition candidates;
matching native Poste status or progress confirms them. Other postal shapes use the generic postal fallback.
Detection names Poste Italiane for the parcels, EMS, registered and tracked-letter items it
issues (`C`, `E`, `L` or `R` first, `IT` last and a valid check digit). Its tracker follows them
abroad, to delivery or back. Poste Delivery International Express codes, `ZC`, nine digits and
`IT`, are Poste's whatever their last digit: its tracker follows them although that digit can
fail the S10 check. Its other `IT` codes stay with the generic postal carrier, and the
low-confidence `poste-italiane-s10` rule makes recognition ask Poste Italiane first. `UB` codes,
for one, label goods for customs and are not tracked.

The adapter also takes the S10 number of mail from abroad, with a valid check digit, so the
hand-off to the destination country's post asks Poste's tracker about mail to Italy. Poste's
[page on receiving from abroad](https://web.archive.org/web/20250317115204/https://www.poste.it/prodotti/ricevere-spedizioni-da-estero.html)
says its tracker follows a tracked item from abroad by its code: a parcel once Poste takes it in
Italy, letter post from the country of origin when that post shares its leg. Complaints in the
corpus quote the tracker for such items, and the
[prior-art client's tests](https://github.com/ha-parcel-integrations/ha-poste-italiane/blob/dbf814a5c1319f77af9855abe5f014e10a829902/tests/payloads.py)
keep its reply for one from Japan. The tracker does not know every item by that number: Poste's
[barcode sheet](https://web.archive.org/web/20241105100904/https://business.poste.it/business/files/1476611371030/scheda-tecnica-prodotto-codice-a-barre-3-di-9.pdf)
gives imported registered and insured letters new codes of its own, ending in `NN`. A
hand-off that finds nothing leaves the item with the sending post. Detection never names Poste
Italiane for a number issued abroad.

## How it works

1. `direct`: one `POST https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice` with
   `{ codiceSpedizione, tipoRichiedente: "WEB", periodoRicerca: 1 }` and `poste.it`
   `Origin`/`Referer`. No cookies, token or account. The echoed `idTracciatura` must match.
   The envelope decides the outcome, not the HTTP status (unknown numbers answer 200):
   - `esitoRicerca` `1` or `2`: not-found.
   - No `esitoRicerca`, parcel type `P` and explicit empty `listaMovimenti`: an old expired parcel, also not-found.
     Unknown and expired look identical to an anonymous caller.
   - `esitoRicerca` `3` with no movements: the parcel exists but is unscanned, so
     `pending`/`registered`, not unknown.
   - `esitoRicerca` `3` for letter post (`tipoSpedizione` `C`) at `stato` `1`, with neither a
     product nor a movement list: a code Poste does not know, so not-found. A code whose check
     digit fails answers that way.
   - HTTP 404/410 means the tracking endpoint is unavailable. After a burst of searches from one
     address, the service answers HTTP 400 with an error envelope asking for a CAPTCHA: a
     challenge. Other non-200 replies remain upstream errors.
   - The CAPTCHA comes once an address has sent twenty searches in the past hour, the refused
     ones included, and stays until the hour holds fewer. So at most eighteen searches an hour
     go through one transport, recognition included, and none for fifteen minutes after a
     CAPTCHA. An HTTP 429 pauses them for the wait its `Retry-After` names, else for those
     fifteen minutes. A lookup over that fails as rate-limited without a request, with the time
     left to wait and the reason `self_paced`, and the browser step does not run. The catalog asks for a refresh at most
     every half hour, and an hour after a failed one, so that a handful of followed parcels,
     including one out for delivery, keeps within the hour's searches.
   - Missing or unusable history is a schema failure. Unrecognized empty envelopes remain inconclusive.
2. `trawl`, only after a challenge: the official page opens in a fresh browser context.
   TRAWL solves its reCAPTCHA checkbox/audio challenge and observes the page retrying the
   same lookup with its issued token. The final response must name the whole requested
   identifier and passes through the same history parser. An unsolved or rejected challenge
   remains a failure, allowing enabled providers to recover. While TRAWL's audio pause is on,
   the page is not opened: it would show the same challenge. HTTP recognition uses only `direct`.
   Both steps share the caller's budget; browser recovery needs at least eight seconds left.
   If the widget disappears while its verified lookup is in flight, capture waits for that
   request within the same deadline. A later failed request cannot leave an earlier answer
   looking complete.

## Notes

- SDA delivery services use [Poste's shipment search](https://business.cert.poste.it/business/files/1476520760931/poste-delivery-business-express-standard-scheda-prodotto.pdf).
  Its [official request builder](https://www.poste.it/cerca-app/js/module/forms-ricerche-directive.js)
  submits the complete code. Detection and adapter eligibility share the catalog rules;
  neither a matching shape nor an expired reply confirms issuance.
- Aggregators name SDA's parcels "SDA", "Italy SDA" or "SDA Express Courier". Those names are
  aliases, so a provider's naming points to Poste's tracker, which still has to know the number.
- Poste's own scans are instants. Its catalog clock is Rome's for the providers: Ship24 relays
  SDA's distribution-center scans as wall clocks without an offset, and they read on that clock
  as the same moments Poste's own copies give.
- [SDA's site](https://www.sda.it/) says its courier services moved to Poste Italiane, so a
  link on sda.it names Poste, and its old shipment links carry the waybill as
  `tracing.letteraVettura`. DHL's country page names SDA as its partner in Italy, but
  [DHL](../dhl/README.md) proposes its parcels to no one there until a scan links the partner.
- Partners abroad hand Poste Italiane parcels under a DHL Parcel Connect plate, `JJD` and
  twenty-one digits, and link to Poste's tracker with it, as PPL does. The adapter takes those
  plates for that hand-off. DHL issues them, so no detection rule names Poste for them.
- Poste Delivery Business Internazionale Plus codes start with `8UW`, as `1UW` and `3UW` codes
  do for Poste's other parcels. Poste's tracker follows them.
- Poste Italiane also prints its codes inside an ISO 15459 plate: `J`, the UPU's issuing-agency
  code `J`, Poste's UPU operator code `ITA` and the thirteen-character code. Poste's tracker
  follows the whole plate and echoes it, so `poste-italiane-plate` claims it at high confidence.
  Aggregators can read the `JJ` as DHL's.
- Parcels booked online through Poste Delivery Web, Poste Delivery Web Express and MyPoste carry
  two letters and eleven digits. Poste's FAQ gives `JG` and `EG` examples, and complaints and the
  communications regulator quote `EF`, `GF`, `JF` and `LF` codes. Poste's tracker names `JF`
  parcels Promo Pacco and follows `GF` parcels from their acceptance at a post office. La Poste's
  thirteen characters share the shape but no corpus number uses these prefixes, so detection
  claims them for Poste Italiane.
- Poste Deliverybox Express boxes carry `X`, a letter, nine digits and `IT`, and their ninth digit
  is no S10 check digit. The shape only suggests Poste Italiane (`poste-italiane-deliverybox`) and
  leaves out the X prefixes Chronopost uses.
- Posta1 letters carry `2IVC` and ten characters.
- PROMOPACCO PLUS parcels carry `F`, three digits, `D` and eight digits. Poste's tracker
  follows them, but no public sample is known, so the shape only suggests Poste Italiane
  (`poste-italiane-promopacco`) and recognition asks it.
- Codes of `D`, five digits, a letter and six digits are Poste's too: its tracker follows
  them, for ROAD EUROPE shipments for instance. No public sample is known, so the shape only
  suggests Poste Italiane (`poste-italiane-d`) and recognition asks it.
- SDA's 13-character codes with a digit before the `C` start with `3`, as complaints quote
  them, with `1`, which Poste's tracker follows for Crono Express parcels, or with `9`, which it
  follows for CRONO PLUS parcels arriving from Cainiao. No public sample starts with `1` or `9`.
- Registered mail (Raccomandata, Raccomandata 1, A.R. and judicial documents) carries eleven
  digits and a check digit, printed after a dash or a space. Poste's
  [barcode specification](https://business.poste.it/business/files/1473808025319/raccomandatagiudiziaria-codice-a-barre.pdf)
  defines the check: eleven times the sum of the digits in even places, plus the sum of those
  in odd places, gives a number whose digit sum mod 10 is the last digit. Every public number
  passes it. The leading digits vary with the product and the sender, so the low-confidence
  rule `poste-italiane-registered` takes any twelve digits whose check holds. FedEx, BRT and
  other carriers take twelve digits too, so the shape only suggests Poste Italiane and
  recognition asks it.
- Envelope `stato` `5` forces `delivered` whatever the movement wording says: a delivered
  parcel sometimes carries a truncated last line. A parcel sent back ends with its delivery
  to the sender; that delivery carries the return flag (`flagRitorno`) and reads as
  `returned`. Without per-movement flags, the envelope flag and an earlier return scan
  decide.
- A return scan or a movement with the return flag after the newest delivery outranks it,
  whatever `stato` says: a parcel left at a pickup point and not collected goes back to the
  sender, and reads as `returned`.
- Stages come from Italian `statoLavorazione` wording. Both the typographic and the ASCII
  apostrophe are accepted (`e' stata consegnata` appears live). Unmapped wording gets no
  stage rather than a regex catch-all guess; the sync records it for review.
- Registered mail words a movement as the end of a sentence, such as "da un nostro operatore
  presso l'Ufficio Postale" or "in data". The official page heads it with its `box`'s
  milestone (2 Presa in carico, 3 In transito, 4 In consegna, 5 Consegnata, 6 In restituzione
  al mittente) and prints the date after it. The adapter writes the label and the rest without
  the trailing "in data", since the scan's time carries the date: "Presa in carico da un nostro
  operatore presso l'Ufficio Postale", "In consegna", "Consegnata con successo". The stage
  follows the sentence, so box 4's "in data" is out for delivery. A movement stored as the bare
  fragment takes the sentence in place (`identity.ts`).
- A failed round that names the day the next one starts from is a failed attempt, not that
  coming round.
- Customs release wording maps to `in_transit`.
- A post-office scan names its office, which becomes the event location; the office's
  address, postcode and hours are not kept. Other scans keep `luogo` only when it is a town
  and province, such as `PESCARA (PE)`, or a delivery "dalla sede operativa di" that town.
  The location adds the country, `PESCARA (PE), IT`, because many provinces share a
  country's code and a final code reads as the country. Any other `luogo`, such as a post
  office's street address or a street named with its province, is dropped.
- `tipoProdotto` names the product, such as Poste Delivery Standard. Letter-post items echo
  their own number there, which is not kept.
- `oneri` lists what an import owes, in euro cents, as `import_charges`: customs duty and VAT,
  the postal fee on delivery and its lower online price. `statoOneri` `PAGATO` marks them paid.
  `FINESTRA_PAGAMENTO_CHIUSA` says the online window shut: the online price is left out, as
  what is left is paid on delivery. Every code stays in `status_code`.
- `dataPrevistaConsegna` is Italian prose ("Consegna prevista entro Venerdì 2 Gennaio 2026"),
  reduced to a calendar day and cleared once delivered. Unparsable text yields no estimate.
- `dataOra` is epoch milliseconds, so there is no zone to guess. A local helper renders it
  with milliseconds (`.000Z`) because those strings are persisted and `core/time`'s
  `epochMillisTime` would drop them.
- At most 20 events are returned, newest first. Movements come oldest first, so of two
  sharing an instant the later one is newer.
- Sender, recipient, address, signature, weight, dimensions and pickup office are never read;
  a test asserts it.
- Browser recovery captures the tracking API, without rendered recipient details or verification
  tokens. It needs the Poste Italiane helper in the optional TRAWL image.

`POSTE_ITALIANE_BROWSER_WS_ENDPOINT` optionally adds a fresh private Playwright browser
session after the existing recovery path is challenged. It opens the current guest tracker
and accepts only the whole-number-bound API reply, under the original lookup deadline.
This path solves no interactive CAPTCHA and retains no browser state between lookups.
HTTP recognition and the direct-search pacing remain unchanged. Keep the endpoint private.

`POSTE_ITALIANE_RETRY_PROXY_URL` optionally sends a share of that existing native-browser
recovery through a residential HTTP(S) proxy, including its credentials when required.
`POSTE_ITALIANE_RETRY_PROXY_PERCENT` selects the share from zero to one hundred, defaulting
to fifty. Assignment happens once per lookup; the proxy carries the whole fresh context,
with no direct downgrade or extra attempt. Route, recovery outcome and dated-history
availability are recorded without the proxy address or credentials. Leave the URL unset
to keep the normal route. Replies must match the whole identifier. Residential replies can
omit an older movement; they are conservatively marked `history_truncated`, keeping richer
provider history eligible even when the current status and latest scan are present.

## Limitations

- No event location for a scan at a post office's street address without its office name.
- Day-resolution estimate only.
- Browser recovery needs Google to serve its audio challenge. While Google shows the browser
  service's address its automated-traffic page instead, the step fails at once and only the
  providers can recover a challenged lookup.
- Poste's tracker also answers those codes with other digits before the `C`. No parcel shows
  one yet, so neither detection nor the adapter takes them.

## Testing

`npm run test:carriers:live -- carriers/poste-italiane`. The unknown-number
check needs no env vars; set `POSTE_ITALIANE_DELIVERED_TRACKING_NUMBER` to also check a real
delivered parcel, and `POSTE_ITALIANE_TRACKING_NUMBER` for a real parcel in any state.
