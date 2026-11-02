# La Poste / Colissimo

La Poste's unified tracking feed. It serves Colissimo, tracked mail and
[Delivengo](../delivengo/README.md), whose folder points `tracking.adapter` here.
The feed also answers Chronopost identifiers, but can omit international partner
scans and references without indicating incomplete history.
[Chronopost](../chronopost/README.md) therefore uses its own direct adapter.

Numeric tracked-mail identifiers reach the same feed without truncation or
conversion to a parcel number. Their detection rules live in `carrier.json`;
generic numeric lengths alone do not identify La Poste. A thirteen-character
Colissimo, tracked or registered letter number ends in a GS1 key over the ten
digits after its two-character product code, and a Smart Data number's optional
15th character is DPD's ISO 7064 MOD 37,36 key. La Poste is
selected only when that key matches; otherwise it stays a suggestion. China Post's `ZS`,
`ZC` and `ZA` numbers share the length but carry no key, and no La Poste number is known
with those prefixes, so its rules leave them to China Post.

Printed control suffixes are preserved in requests and checked against the
returned shipment identity. A Smart Data number typed without its optional
check character comes back under the full fifteen characters; that identity is
accepted only when the character matches, and becomes `canonical_tracking_number`. La Poste's
[Smart Data guide](https://www.espacetechniqueetqualite.laposte.fr/system/files/public/FICHE%20PRATIQUE_Utilisation%20des%20num%C3%A9ros%20de%20suivi%20SD_Lettre%20suivie.pdf)
describes their use; a suffix alone does not identify the carrier.

## How it works

1. `direct`: one keyless GET of
   `https://www.laposte.fr/ssu/sun/back/suivi-unifie/{number}?lang=fr`, the feed
   the public tracker calls, with the tracker page as `Referer`.
2. `retry`: the same request, up to three times after an HTTP 403, and once
   after a network failure or timeout, only while the original 15-second
   deadline has time left. Until that network retry is spent, an attempt gets
   at most half of the time left, so a request that hangs leaves time for it;
   the retries share the rest, so they never extend the lookup.

While the parcel waits at a post office, relay or locker, the step that read the
feed then asks La Poste's locator for that point,
`https://localiser.laposte.fr/{idPoint}`, the page the tracker links to. It gets
at most three seconds and half of the time left; any failure leaves the point's
name alone. The page is large and a point's address does not change, so a
tracker remembers the addresses it has read and asks once per point.

The feed answers with an array; only the entry whose `shipment.idShip` equals
the requested number is read. `returnCode` 104 is the only positive not-found;
any other non-zero code is inconclusive, so the router can fall back to a
universal provider. A number outside La Poste's formats gets HTTP 400 with
`returnCode` 412 ("numéro non postal") instead. That is invalid input, so
recognition reads it as unknown rather than as a transport failure.

## Notes

- The 403 is usually La Poste's "Site indisponible - Incident en cours" page.
  Despite the wording it is a one-request edge hiccup, not maintenance: the next
  lookup succeeds, and it is most likely on the first request after a quiet
  period. Treating it as maintenance and skipping retries sent roughly ten
  times more lookups to the router, each benching the adapter for an hour. A real
  incident still fails all four attempts within seconds.
- Only a 403 and a failure to reach La Poste are retried. A 429, a not-found or
  a malformed payload won't be fixed by an instant repeat. A hang gets one more
  try rather than the whole budget.
- The retries are three separate runner steps with the id `retry`, not a loop,
  so each rejection keeps its own diagnostics and the `attempts` label on
  `carrier_lookup_total` shows which retry served the lookup. `steps` lists
  tiers (`direct`, `retry`), not attempts.
- The deadline check lives in the `recovers` predicate. An exhausted lookup
  still throws the provider's `UpstreamHttpError` (403), not a
  `BudgetExceededError`.
- Status precedence: incident wording, then event `code`, then `group`, then
  wording. La Poste keeps a failed delivery inside its original group
  ("Incident : livraison impossible" arrives with code `DR1`, meaning
  registered).
- `DISTOU`/`MD1` ("sur son site de distribution. Nous le préparons pour le mettre en
  livraison") is out for delivery, for parcels and letters alike. It is the sort into the
  morning's round: the delivery or a failed attempt follows the same day, and La Poste
  sends no other round scan.
- `PB1` is a delivery that could not happen that day. Parcels word it as a
  coming delivery round, so the code makes it a failed attempt.
- `AG1` means ready for pickup whatever its group or sentence. `DO1` is customs
  entry, `DO2` the release and `RE1` the decision to return the item. Duties paid
  at the door (`DESPAY`) follow the delivery scan and keep it delivered. Pickup and customs are set as `current_stage` because the status
  vocabulary has no value for them.
- A return stays open until the parcel is back with its sender: `RE1`, the `RETOUR` group and
  other return wording are an exception, as the shared rules read a return under way, and only
  `DI2` (groups `DESLREXP` and `DESMDREXP`) or wording that has the sender receive it is returned.
  Apps treat a returned parcel as finished.
- Scans in France and its overseas departments keep the feed's timestamp, which
  carries its offset; impossible dates are dropped. That holds for imported
  tracked mail's arrival and transit in France too: the posts that relay them,
  Royal Mail and India Post, show the same instant to the minute. A partner
  post's scan abroad shows that office's wall clock under the wrong offset:
  Colissimo gives it the Paris offset, and imported tracked mail ("Lettre et PPI
  import suivi") reads it as UTC and shows it on Paris's clock. So does an
  international tracked letter sent from France (an `L` number ending in `FR`): a
  Dutch scan of one reached the feed before the instant it was labelled.
  Those scans are read in the country's zone, or kept as `local_time` when the
  country has several. Other products keep the feed's instant until their partner
  scans are compared with the partner's own. The app's identity policy lets a corrected Colissimo scan
  take over the row stored under the Paris label.
- A sender's announcement (`EXPANN`, `DR1`) that some senders date by its day alone comes at
  midnight on Paris's clock, where the others carry their time of day. It keeps that day in
  `local_time` instead of a midnight nobody scanned.
- Colissimo enters some transport scans at their planned time, before they happen. A scan
  dated more than five minutes after the lookup is held back until it is due (`plannedScans`).
- `contextData.partner` names the foreign carrier after export; it becomes
  `delivery_carrier` and `delivery_tracking_number`. Its name can be French or the
  postal union's company name. A brand with several networks, such as DPD, is
  read from its link: DPD with myBRT's link is BRT. An item whose `product` is
  Chronopost names Chronopost instead, whose own tracking holds the scans and
  references this feed can omit, so the tracker asks it too.
- `contextData.merchantName` is the sender the tracking page shows. While the
  parcel waits for collection, `removalPoint.name` names the post office, locker
  or shop holding it and becomes the pickup point. The feed has no address for
  it, but `removalPoint.idPoint` is the point's id on the locator, whose page
  carries the point's record as JSON in `Yext["profile"]`. When its `meta.id` is
  that id, the record's street (`address.line1`) and its postcode and town
  follow the name on their own lines. The point's phone, opening hours and
  coordinates are not read. A delivered parcel has none, collected there or not.
- `arrivalCountry` repeats `originCountry` on some international items, inbound
  ones included. Such a pair stands only while every scan stays in that
  country; otherwise a delivery scan's country is the destination.

## Rejected approaches

- Scraping the public tracker page: it calls this keyless feed itself.
- Retrying a 403 with backoff: the hiccup is brief, so waiting only spends the
  user's deadline.
- Treating every non-zero `returnCode` as not-found: that reports parcels
  missing during a provider outage.

## Limitations

- `location` is the event's country; the feed has no city, and its Chronopost
  items carry no country either.
- The delivery estimate is dropped once the shipment is final or delivered: a
  delivered item can stay non-final with its delivery time as the estimate.
- Recipient blocks and addresses on the shipment and its events are never read;
  events are built from an allowlist of wording, time, country and codes.

## Testing

`npm run test:carriers:live -- testing/frenchDirectCarriers.live.test.ts`
(no env vars) checks a wrong number gets a clean not-found or the recognized 403.
