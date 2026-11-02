# Fargo

Fargo (Fargo Parcel Service) is an Uzbek courier delivering within Uzbekistan and abroad. It is
not the Kenyan Wells Fargo courier. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://fargo.tezbor.uz/api/v1/public/order/{number}/history_items`, the
   tracking service the page at fargo.uz/track names in its configuration. It needs no cookie,
   token, key or browser. The JSON reply lists the order's history items newest first.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- An unknown ID is a 404 whose reply has the code `order_not_found`, which the page reports as
  not found. A 404 without it, or a redirect, is a moved route.
- A 429 is a rate limit. Its wait comes from `Retry-After`, else from the seconds the reply
  names, as the page reads it. A 403 or a firewall page is a challenge.
- Recognition makes the same request.

## Notes

- The reply names no order, and the page shows the ID typed in as the order's. The tracker
  matches the whole ID exactly: a lower-case, shortened or prefix-less form of a known ID is not
  found. So the lookup binds the reply to the ID asked. The tracker also finds an order by the
  shop's own order number, which the reply cannot confirm, so the adapter sends only the track
  ID's layout.
- Each item has a status code, an English wording whatever language is asked, and an instant in
  UTC, which the page shows on Tashkent's clock. The adapter keeps Tashkent instants. A code the
  reply gives no wording, such as `created`, takes the page's own label.
- The code sets the stage, from the page's own list of codes. A delivery attempt is logged with
  each try at the same instant as its outcome: a delivery, or the reason the courier gave for
  not delivering, which is the failed attempt. Codes before collection, including acceptance,
  stay registered, as the page's progress rail has them. Problems collecting from the sender,
  courier assignments, bare updates and the cash passed on to the shop move nothing.
- The current status passes over a bare update, as the page does.
- A scan's location is its warehouse and town, as the page shows them. The courier's name and
  account are not kept.
- The reply names no other carrier or number, so there is no hand-off.

## Limitations

- No estimate, weight, service or proof of delivery.
- A shop order number is refused as invalid input, even though the tracker would look it up.

## Numbers

The tracker's field shows a track ID as `TEZ` and six digits, and asks for that or the shop's
order number. The tracking service runs on the Tezbor delivery platform, whose name the prefix
shares, so no rule claims it. The adapter also takes longer digit runs after `TEZ`, so a longer
serial still works. Archived lookups on the former tracker at my.fargo.uz show nine- and fourteen-digit ids,
which the current tracker does not find; the adapter does not take them. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracker reads the number from `id` on `fargo.uz/track` and its Russian and Uzbek pages, and
older lookups used `my.fargo.uz/track/?id={number}`, which now redirects there. Both are read as
links.

## Testing

`npm run test:carriers:live -- carriers/fargo-uz`, with `FARGO_UZ_TRACKING_NUMBER` and
optionally `FARGO_UZ_UNKNOWN_NUMBER` set outside the repository.
