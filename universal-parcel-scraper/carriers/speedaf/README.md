# Speedaf

Speedaf Express (速达非) is a Chinese-owned courier network in Africa, the Middle East,
Pakistan and a few European countries. It flies parcels from its warehouses in China and
delivers them itself in the destination country. Mauritius and La Réunion have no site of their
own but use the same tracker. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://www.speedaf.com/publicservice/v1/api/express/track/listExpressTrack`
   with the body `{"mailNoList":["{number}"]}`, as the tracking page's script sends it. It needs
   no cookie, token, key, signature or browser. The JSON reply has one entry per number, with the
   destination country, a few waybill flags and the scans, newest first.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- The tracker reads a number in lower case as unknown, so the number is sent in capitals.
- The service answers HTTP 200 for every number, including errors. A 404 or a redirect is a
  moved route, not a missing parcel.
- The entry must echo the number asked. An entry without a destination country or a scan is a
  number Speedaf does not know: not found. An entry with its country but no scan is a waybill
  whose scans are not shown, which happens to older parcels: no history.
- `success: false` with an error message is inconclusive, or a rate limit when the message says
  the client asks too often.
- Recognition makes the same request.

## Notes

- Each scan's `time` is the scanning site's wall clock and `timezone` its offset in hours: 8 in
  the Chinese warehouses, then the destination's, such as 1 in Nigeria or 4 in Mauritius. The
  adapter returns the time at that offset, which keeps a history crossing from China in order. A
  scan without a usable offset keeps its wall clock.
- The scan's `action` stages it, with its `subAction` when that differs: the provider code is
  `action:subAction`, such as `3:3001` for an arrival at a distribution centre. Issue scans
  (`-1`) give their reason only in the sub-action, so the map stages the reasons it knows, a
  rescheduled delivery or a refusal, and leaves others to the wording. The action labels come
  from Speedaf's WooCommerce plugin; the tracker also uses actions the plugin does not list.
- The wording is English, else Chinese. The local-language wording can be in a language whose
  labels the adapter does not know. Pickup, delivery and signature scans name the courier, the
  scanning clerk and the recipient, and in some countries the courier's phone. The adapter
  removes the names and phone numbers, and ends the wording where it introduces the courier,
  whose name is not always in brackets.
- The page hides action `-2` unless the waybill carries its exception flag, and the adapter does
  the same.
- Sites are Speedaf's own names and codes inside the wording, so scans have no location.
- The reply's duty payment link, proof-of-delivery photo and scanning device are not kept.
- A multi-piece waybill lists its pieces under other numbers. Only scans carrying the number
  asked are read; the pieces are not followed.

## Limitations

- No delivery estimate, weight, service, location, sender or recipient.
- The tracker does not know Cainiao's own references for the same parcels.

## Numbers

Speedaf numbers start with the destination country's code. Its tracker answers two layouts:

- the country code and twelve digits, sometimes followed by `T`;
- the country code, nine digits and a letter, `R` in most samples. AliExpress shows its buyers
  this number for parcels Speedaf delivers, and Speedaf's tracker answers it as its own waybill
  from the Chinese warehouse on.

Both rules take only a prefix for a country where Speedaf numbers have been seen. `speedaf-r`
detects the second layout with high confidence: no other carrier's numbers in the corpus or the
harvested pages end in a letter after nine digits, and it otherwise overlaps only Colis Privé's
rule for any twelve characters, whose numbers end in digits. `speedaf-12` only suggests
Speedaf, because the same country-and-digits shape turns up in Instabox and Bring samples. It
takes `IE` too: Speedaf's site lists a customer service in Ireland and an Irish number in that
layout has been seen, but no public page shows one, so the corpus holds a made-up number. The
samples and their sources are in [`numbers.json`](numbers.json).

## Testing

`SPEEDAF_TRACKING_NUMBER=... SPEEDAF_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/speedaf`
