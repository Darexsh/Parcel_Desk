# Latvijas Pasts

Tracks Latvijas Pasts items, its own and those from other posts it delivers in Latvia, through
the anonymous service behind its own tracking page.

## How it works

The tracking page on `mans.pasts.lv/track` reads `GET https://mans.pasts.lv/tracking-api` with
the number as `id`, a locale as `lang` and `include_group=true`. The adapter sends that one
request for one number and asks for English (`lang=en-US`). No account, cookie, key or browser is
needed. The service answers JSON only when the request accepts it, and XML otherwise, so the
adapter sends `Accept: application/json`. A request that fails to reach the service is sent once
more within the budget.

The page loads reCAPTCHA and a Keycloak login for the rest of Mans pasts, but its tracking request
carries no token or session.

The reply does not repeat the number: it answers for the one number the request names. A number
without history comes back with the notice "No information received on the tracking of the postal
item. Please, try again!", and only that notice is a missing item. A code the service rejects as
"entered incorrectly" is invalid input. Another notice, an empty history, a block page, HTTP
errors and malformed replies keep their own failure kinds. While the site is closed, every page,
the service included, answers HTTP 403 with "Temporary closed for technical reason.": that is
maintenance, not a challenge. Recognition uses the same lookup.

## Numbers

The adapter takes S10 codes with a valid check digit, from any country; anything else is invalid
without a request. Latvijas Pasts' own items end `LV`, and items from abroad answer under their
foreign S10 code. Mail from abroad reaches Latvijas Pasts when a caller names it, a provider names
it, or a result gives Latvia as the destination of an S10 item.

Detection names Latvijas Pasts for the parcels, EMS, registered and tracked-letter items it
issues: `C`, `E`, `L` or `R` first, `LV` last and a passing check digit. Its tracker relays the
destination post's events of an item sent abroad through to delivery. Its other `LV` codes stay
with the generic postal carrier, as the issuer of an S10 code does not establish who delivers it,
and a low-confidence rule makes preflight ask Latvijas Pasts about them.

## Notes

Each scan carries a numeric event code, its wording, a clock and the Latvian office, or the
country of an event a foreign post relayed. Both share one code list, which the adapter maps;
codes it does not know go to the shared wording rules. "Item returned from Customs" is a customs
release, not a return. The pickup point is the office that printed the invitation to collect the
item, while it waits there or once it was collected there.

Clocks carry no offset. A Latvian office's scan is on Riga's clock, and a foreign post's event on
its country's when the country keeps one zone; other events, and a clock that summer time makes
ambiguous, stay local times. Scans at the same second follow the tracker's progress groups, from created to delivered,
then the reply's order. A repeated foreign event counts once.

An office without an English name comes back as "Pasts", the company's name, and gets no
location. Office postcodes, the delivery office named ahead of the delivery and the non-delivery
reason and action are not read.

## Limitations

Return, failed-delivery and parcel-locker codes have not been seen live; their scans are staged by
their wording until the map knows them. An item whose history the service no longer keeps answers
like an unknown code.

## Links

Latvijas Pasts's search page on `www.pasts.lv/izsekot-sutijumu` sends the number to
`mans.pasts.lv/track?locale=lv-LV&id={number}`, which looks up the number it finds in the address.

## Live test

Set `LATVIJAS_PASTS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/latvijas-pasts/adapter.live.test.ts`.
Optionally set `LATVIJAS_PASTS_UNKNOWN_NUMBER` to check a code without history.
