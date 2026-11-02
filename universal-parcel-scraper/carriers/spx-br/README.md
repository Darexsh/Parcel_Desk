# SPX Express Brazil

SPX Express Brazil is Shopee's delivery network in Brazil. It collects from sellers in Brazil,
carries Shopee's parcels from overseas sellers through its own warehouses abroad and Brazilian
customs, and delivers to the door.
Tracked through the lookup its tracker makes. `spx-ph` covers the Philippine network, whose
numbers carry a PH prefix.

## How it works

1. `direct`: one `GET https://spx.com.br/shipment/order/open/order/get_order_info` with
   `spx_tn={number}&language_code=pt`, as the tracker sends it for the number in its address.
   It needs no cookie, token, signature or browser. The JSON reply has the parcel's scans,
   newest first.

- An unknown number is HTTP 200 with a non-zero `retcode` whose message says the order index
  found none (`find [0]`). The page shows "Sua busca não gerou resultados" for that and for any
  other failure, so only that message is not found; other failures are inconclusive. A 404 or a
  redirect is a moved route, and a web page in place of the JSON is a gateway's check.
- The tracking object must name the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `actual_time` is Unix seconds, so every scan is an exact instant. The page shows
  them in Brasília time, but the network also spans Brazil's other zones, so no wall clock is
  derived.
- `pt` is the page's own language code. Its lines name no one; the `pt-BR` lines put the
  recipient's name in brackets after a delivery, and the buyer's line adds who received the
  parcel. The adapter reads the `pt` line and still drops a clause naming who received it.
  Scans without a Portuguese line keep their English tracking name.
- The page leaves out the rows SPX flags hidden. Most are bookkeeping and stay out. A pickup
  that collected nothing, import clearance, the arrival at the last-mile hub and a return's way
  back are kept: no row the page shows stands for them, and a return's first shown row comes
  days after the parcel turned back.
- Scans at SPX's warehouses, forwarders, ports, hubs and sorting centres keep the place and
  coordinates the reply gives. Pickups, postings, deliveries and the return to the seller would
  name the seller's or the recipient's town, so they keep none: the town a posting's wording
  names after it ("Pedido postado Cidade Exemplo - SP") leaves the wording, and a row stored with
  it keeps its row. Facility addresses are not kept.
- Some facility wordings name their centre, origin or port after a colon ("Seu pedido saiu do
  centro logístico: Cidade Exemplo - SP"). The name leaves the wording, so it reads the same from
  town to town, and is the scan's place when the reply gives none: a departure from a logistics
  centre often names it only there. Rows stored with the name in their wording keep their row.
- The reply can list a customs check filed late among later scans; the history is ordered by
  the clocks.
- Tracking codes give the stages. Brazilian customs holding or inspecting a parcel is customs,
  its refusal to import is an exception, and every leg of a return is returned.

## Limitations

- No delivery estimate, weight or delivery partner.
- The lookup also answers the numeric order reference its reply carries, which no rule claims.

## Numbers

Archived lookups on the tracker show BR followed by thirteen characters: twelve digits and a
final digit or letter, and the tracker still answers them. No other network issues that
layout, so the rule names SPX Express Brazil for it.

## Links

`spx.com.br/track?{number}`, with the number as the whole query string, is the address archived
lookups use, as on the Philippine tracker. After a search the tracker script moves to
`spx.com.br/detail/{number}`.

## Testing

`npm run test:carriers:live -- carriers/spx-br`, with `SPX_BR_TRACKING_NUMBER` and optionally
`SPX_BR_UNKNOWN_NUMBER` set outside the repository.
