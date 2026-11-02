# KEX Express Hong Kong

KEX Express (Hong Kong) is the Kerry Logistics Network's local express carrier, formerly Kerry
Express Hong Kong. It collects from senders and self-pickup points and delivers across Hong
Kong. It has its own site and tracker, separate from KEX Express in Thailand (`kex`). Tracked
through its tracker's page.

## How it works

1. `direct`: one `GET https://www.kex.kln.com/en/track?track={number}`, the page the tracker's
   form opens. The server renders the parcel's history into it. It needs no cookie, token,
   captcha, phone digits or browser.
2. `retry`: one more read when KEX Express cannot be reached or does not answer in time.

- An unknown number is HTTP 200 with the notice "Sorry, KEX Express have not yet received
  information of this tracking no." under the number. An input the tracker does not take gets
  "Sorry, Invalid input the tracking no." without the number, which is invalid input. A 404 or
  a redirect is a moved route.
- The result block shows the number as it was typed and must show the whole number asked. The
  tracker matches whole numbers, in any case. It also answers some much shorter references, so
  the adapter sends only eight to twenty letters and digits with a digit.
- Imperva sits in front of the site. Every page loads its script, so only a page without the
  tracker's result area is read as a challenge.
- Recognition makes the same request.

## Notes

- Each scan has a day and `AM` or `PM`, not a clock, and no location. The day is `local_time`;
  the half-day only orders scans within a day. The page lists scans newest first; an older
  version listed them oldest first, and the adapter turns such a page round.
- The page can list one scan twice in the same half-day. The copy is dropped.
- Scans have no code, so their wording stages them. Parcels from before the rename keep the
  Kerry Express name in their wording, which the map reads as KEX Express. Phone numbers and
  collection codes are taken out of wording.
- The official app (`link.express.kehk`) reads orders from an API that needs a signed-in or
  verified session. Its guest view asks for the recipient's phone number for more detail, so
  it is not used.

## Limitations

- No clock, location, weight, estimate or proof of delivery.
- Wordings for failed deliveries, self-pickup and returns have not been seen; the shared
  wording rules stage them.

## Numbers

Archived lookups show a letter followed by nine digits and, under the former name, a
fourteen-character number starting with KEHK. The app gives a letter and seven digits as its
example. No rule claims them: the first shape is printed by other carriers, and the second
rests on a single sample. Recognition can tell a known number from an unknown one, but
without a rule offering KEX Express Hong Kong it is not asked; a caller names the carrier or
pastes a tracking page link. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`kex.kln.com/{en|zh}/track?track={number}` opens one parcel; the tracker's own form submits
there, and it reads several comma-separated numbers too. The former
`hk.kerryexpress.com/track` and `/en/track` addresses used the same parameter.

## Testing

`npm run test:carriers:live -- carriers/kex-express-hk`, with `KEX_EXPRESS_HK_TRACKING_NUMBER`
and optionally `KEX_EXPRESS_HK_UNKNOWN_NUMBER` set outside the repository.
