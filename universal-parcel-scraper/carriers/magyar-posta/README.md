# Magyar Posta

Tracks Magyar Posta and MPL items through the guest tracking of the Posta app, with the public
tracker at [posta.hu](https://www.posta.hu/nyomkovetes/nyitooldal) as a fallback, both driven by
the TRAWL browser service: domestic MPL parcels, S10 items Magyar Posta issues, and items from
other posts it delivers.

## Numbers

Domestic MPL numbers are `P`, a product letter, a three-character customer code, seven digits
and a check digit. The seven digits weigh 3 and 1 alternately from the left, and their sum mod 10
is the check digit; the MPL API guides' examples and the public numbers pass it. Such a number is a
suggestion led by Magyar Posta; one with a numeric customer code also fits La Poste's
two-characters-and-eleven-digits rule. Each package of a shipment also has a package number:
the shipment's number, a three-digit package index and ten more digits, 26 characters in all, as
the MPL API guide's examples show. `magyar-posta-package` suggests Magyar Posta for it first. S10
items ending in `HU` stay with the generic postal carrier, which lists Magyar Posta first among
the direct carriers.

The tracker names two more series. Domestic registered letters are `RL` and fourteen digits.
The guide for identified letters' barcodes gives their `KA` sibling a four-digit customer code,
a nine-digit serial and a check digit over the serial, but nothing documents that check for
`RL`, so the rule takes any digits. MPL Europe Standard parcels, which DHL carries within the
EU, are `JJH` and seventeen letters or digits; the tracker's only example is a
placeholder, so the rule fixes nothing past the length. Both rules suggest Magyar Posta at low
confidence.

## How it works

1. `app`: a number added before is read again from the app's guest API under
   `net.posta.hu/mpl/public/api/mobile/guest`, with the application id it was added under. This
   read needs no token.
2. `trawl`: the helper [`magyar-posta-app.mjs`](../../trawl/magyar-posta-app.mjs) adds the number.
   The app renders an invisible reCAPTCHA Enterprise widget in a WebView whose base URL is
   `net.posta.hu`. The helper renders the same page on that origin in a fresh context, answers
   its audio challenge with TRAWL's speech-to-text and posts the number under the adapter's
   application id. It returns the reply without names, phone numbers or the token.

The adapter asks the app's API for an application id when it first needs one, as the app does on
its first start, and keeps it in memory with the numbers added under it. After fifty numbers, new
ones go to a fresh id. The key the app sends is the same for every install, so the adapter
carries it.

The browser service also retains up to a thousand successful guest registrations in memory for
a day. After an adapter restart it uses one to fetch fresh scans without another widget; it
keeps the guest id inside the service and caches no history. An empty guest list expires the
registration and permits the usual verification. A refused, rate-limited or malformed read
returns its failure without another addition. Retained reads remain available during the
widget's refusal cooldown; a cache miss does not open another widget during it.

While the app's API refuses that key or is gone, the `trawl` step uses the tracker instead. The
helper [`magyar-posta-browser.mjs`](../../trawl/magyar-posta-browser.mjs) opens the tracker the
public page frames, `www.posta.hu/ikrnyomkovproxy/`, in a fresh context. It fills the number in,
solves the reCAPTCHA checkbox with TRAWL's solver, searches, and keeps the result page the search
for that number redirects to, without scripts or form tokens. Every search needs a new checkbox
answer. A search the tracker refuses comes back as its form without a redirect, which is a
challenge.

Neither route answers without the browser service, so HTTP recognition does not ask Magyar Posta.
Browser recognition asks it first for S10 items ending in `HU` and MPL numbers. Only the app's
dated scans confirm a number there: the tracker's wall clocks name no instant.

The tracker answers in the language the browser asks for. The helper sets the tracker's own
Hungarian language cookie, and the parser and status map read Hungarian. The result must name
the whole number in its search field, its item and the item's log. The app is asked in Hungarian
too, and its reply must name the whole number.

Google's refusal shows in the challenge frame's class names in every language: its
automated-traffic page, or an error under an audio answer asking for more. Both helpers stop
there, and an unsolved widget ends before the browser deadline. Either is a challenge. After
Google's refusal, lookups through that widget fail as a challenge for ten minutes without
opening a browser.

## Notes

- Each scan's icon carries the tracker's category: 1 acceptance, 2 processing, 3 transport,
  4 delivery and 5 delivered. The app names the same categories. It is the event's
  `provider_code`. The wording refines it, following
  Magyar Posta's [event list](https://www.posta.hu/static/internet/download/Nyomkovetesi_esemenyek.pdf):
  an item announced by its sender is registered, an undeliverable item on its way back is
  returned, and a delivery after a return is the return's end. Category 4 has no stage of its own.
- Cash-on-delivery settlements with the sender come after the delivery and move nothing, so they
  are left out. Repeated delivery rows count once, and so does a scan listed again under a minute
  later without its place.
- The app's scans carry UTC instants, which events keep in `time`. The tracker shows Budapest
  wall clocks without an offset; its events get `local_time` and the result `last_update_local`.
- An item from abroad can list its next leg at the time it is planned, a day ahead. A row more
  than five minutes after the lookup, on Budapest time for the tracker, is held back until then.
- The app's copies of the origin post's scans carry that post's instants to the minute. They stay:
  an app tracking the origin post too can pair them with its rows.
- A parcel's details name its service. The post office, PostaPont or locker an item waited at is
  its pickup point. The line naming who received an item is dropped.
- The tracker's notice for the number is not found. The app answers a number it does not add,
  as an unknown one, with HTTP 502 and "Unsuccessful Action!", which stays indeterminate; it is
  not asked to add that number again for half an hour. A block page or a 401/403 is a challenge,
  429 is rate limited, and 404/410 means the route is unavailable.
- The app's guest API limits requests per address. Generating ids and adding numbers share a
  small allowance; reads have a larger one.
- Google can answer the tracker's audio challenge with its automated-traffic page at the first
  audio request from a server address that still gets audio for the app's widget. The two use
  different site keys.
- Not used: the MPL tracking API on `core.api.posta.hu` needs a client id and secret from MPL's
  business registration. The previous app's `PostaWeb/TrackingInfo` read is refused by the
  site's firewall. Older tracker endpoints answer 404, and the former tracking host no longer
  resolves.
- The page's `?searchvalue=` link fills the number into the tracker's search; the visitor still
  ticks the checkbox.

## Limitations

- Lookups need a TRAWL image that includes the helpers.
- Adding a number needs Google to accept an audio answer from the server's address. Lookups
  then fall back to the universal providers.
- A browser-service restart loses its retained guest registrations.
- The app has added package numbers without listing them under the number. The schema error says
  whether its reply listed no item, the shipment's number or other numbers, since no such reply
  has been seen whole.
- At most 100 scans are kept.

## Testing

`npm run test:carriers:live -- carriers/magyar-posta` with `FLARESOLVERR_URL` and
`MAGYAR_POSTA_TRACKING_NUMBER`. Optionally set `MAGYAR_POSTA_UNKNOWN_NUMBER` to check that the
app does not add an unknown number.
