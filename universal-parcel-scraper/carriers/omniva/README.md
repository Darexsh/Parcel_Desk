# Omniva

Tracks Omniva items in Estonia, Latvia and Lithuania, parcel machine and courier parcels and
postal items, through the guest lookup of Omniva's official app.

## How it works

The web trackers on `minu.omniva.ee`, `mana.omniva.lv` and `mano.omniva.lt` ask their own API,
which wants a Cloudflare Turnstile token and refuses requests without one. Omniva's Android app
looks a number up with `GET https://mobile-be.omniva.ee/api/v2/shipment/trackSingleShipment/{number}`,
which answers JSON without an account, key, cookie or token. The adapter sends that one request; a
request that fails to reach Omniva is sent once more within the budget.

The reply must name the whole requested number. A number the service does not know comes back as
an empty object, the same answer the web trackers' API gives, so it is not found. Block pages,
HTTP errors and malformed replies keep their own failure kinds. Recognition uses the same lookup.

## Numbers

Omniva tracks UPU S10 items, its own ending `EE` and those of other posts sent to the Baltics,
and its parcel ids: `JJEE` and seventeen digits, or `JJEE`, three letters and eleven digits. Its
Lithuanian tracker also answered `ZA` and eight digits with a history, a layout Omniva does not
document. The adapter takes these and treats anything else as invalid without a request. An
S10 item from abroad bound for Estonia is handed to Omniva under the sending post's number.

`omniva-1` and `omniva-2` claim the parcel ids. Detection names Omniva for the parcels, EMS,
registered and tracked-letter items it issues: `C`, `E`, `L` or `R` first, `EE` last and a passing
check digit. Its tracker carries such an item's scans in the destination country. `RO`, `CR` and
`CV` codes are left out: Meest's tracker and its customers' reviews give them for parcels to
Ukraine, and Omniva's tracker has answered none of them. Its other `EE` codes stay with the generic
postal carrier, as the issuer of an S10 code does not establish who delivers it, and a
low-confidence rule makes preflight ask Omniva about them. No rule claims the `ZA` layout.

## Notes

Each scan carries an event code from the trackers' dictionary and its English wording. The adapter
maps the codes, cross-border items' UPU events among them, and keeps the code. A message to the
recipient keeps the stage of the scan before it, and a delivery after a return started reaches
the sender, so it reads as returned. The reply lists scans in no set order; they are sorted by
clock. Clocks are UTC instants, which the trackers show in Tallinn time.

Once a cross-border item waits at a parcel machine, Omniva also writes the UPU event for the
sending post (`TRT_SHIPMENT_EDH`), a moment after its own scan, without a site and worded for a
post office. Within minutes of Omniva's own scan of the site it repeats that scan and is dropped,
so the item reads as waiting at the parcel machine. Alone, it is kept.

A scan's site is kept by its English name, else its own, only when it is one of Omniva's or its
partners' sites, such as a parcel machine, post office or terminal. Sender and recipient
addresses, postcodes, internal workstation codes and the event parameters, such as notification
channels and failure reasons, are dropped. The pickup point is the parcel machine or post office
an item waits at, or was collected from, else the recipient's chosen one while it waits. A reply
without scans is read from the item's state as a summary.

## Limitations

The service trims an old item's history to its delivery, or to nothing but the state, so such a
history is marked truncated. The reply has no delivery estimate. Codes whose meaning for the
delivery is unclear, such as a hold at a depot or a returns centre, are left without a stage.

## Links

The trackers open one item at `/track/{number}`; archived lookups also used their former
`minuold`, `manaold` and `manoold` hosts. Older tracking pages on `omniva.ee` and `omniva.lt`
took the number as `barcode`.

## Live test

Set `OMNIVA_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/omniva/adapter.live.test.ts`.
Optionally set `OMNIVA_UNKNOWN_NUMBER` to check a number the service does not know.
