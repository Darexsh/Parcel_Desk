# Emile

Tracks Emile's Canadian parcel history through its anonymous XML service.

## How it works

One POST to `https://www.emileps.com/emile/track` submits the barcode and requests
English scans. The official OMS client's [request builder](https://web.archive.org/web/20251026222133id_/https://oms.emileps.com/js/642.e9f3ffa8.js)
and [tracking form](https://web.archive.org/web/20251026222133id_/https://oms.emileps.com/js/806.87f63109.js)
define this flow. No account, credential or browser is needed. The newer
[public page](https://www.emileps.com/tracking) uses a separate `/api/track`
JSON wrapper that requires a fresh Turnstile token; the XML route does not.

Barcodes are `EM`, twelve or sixteen digits, and `CA`. The sixteen-digit form is printed on
parcels 4PX hands over, so recognition asks [4PX](../four-px/README.md) first and keeps
Emile for the parcels 4PX does not know.

The reply must identify exactly one matching Canadian parcel. Absence requires
the service's explicit error naming the requested barcode. Empty histories,
unrelated errors and blocked pages retain their own failure kinds. HTTP
recognition uses the same lookup; the number's shape alone remains a suggestion.

## Notes

Each scan's `GMT` offset determines its instant. Missing or malformed offsets
retain local clocks without assigning a Canadian zone. The official clients
reverse the oldest-first feed, including equal-time scans. The operation code
is retained; the history's sequential row number is not a status code.
Driver assignment stays in transit until the delivery-round scan. Completed
returns remain distinct from delivery. Notification and billing entries leave
the preceding milestone in place.

The same vocabulary stages scans a universal provider files under Emile's name.
Scans filed under the consolidator's name use the provider's shared wording rules.
Provider fallbacks remain opt-in; their coverage evidence is in
[COVERAGE.md](../../providers/COVERAGE.md). A consolidator naming Emile and its
whole tracking number can now propose a direct handoff confirmation.

## Limitations

Remarks, event details, postcodes, phone numbers, upstream references and proof
images are excluded. Locations use only the feed's city and province. Histories
beyond the output limit are marked partial. The retired OMS hostname is needed
only as source evidence, not during retrieval.

## Live test

Set `EMILE_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/emile/adapter.live.test.ts`.
Optionally set `EMILE_UNKNOWN_NUMBER` to check an absent parcel.
