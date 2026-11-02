# Logisimple

Logisimple is a Portuguese carrier for bulky goods such as furniture, which it delivers on a
day agreed with the recipient and can assemble. Tracked through the tracking page of its
customer portal.

## How it works

1. `direct`: one `GET https://portal.logisimple.pt/pt/tracking?tracking={number}`, as the
   page's search form submits it. It needs no cookie, token, key, postcode or browser. The
   portal renders the page on its server: a card headed `TRK#{number}` with the sender's
   reference, the expected delivery and a table of scans, newest first.
2. `retry`: the request once more when it fails to reach the portal or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A number the portal does not know gets "Não encontrámos correspondências para o código de
  envio" with the number, read as not found. The page answers with HTTP 200 either way, so a
  redirect or a 404 is a moved route, and a firewall page or a 403 is a challenge.
- The form takes several numbers at once and shows a card for each, so only the card headed by
  the whole number asked is read. A notice or a card for another number leaves the answer open.
- No rule claims Logisimple's numbers, so recognition does not ask it.

## Notes

- The page is a customer portal Intercourier's tracking page also runs on, so the request and
  parser live in [portal.ts](portal.ts), with the host, number layout and status map passed in.
- Portuguese is asked for because the English page leaves some states blank and drops their
  explanations.
- A scan has a day, a minute, a state, a warehouse, the state's explanation and remarks. The
  state is the scan's wording and decides its stage; the explanation is the same sentence for
  every scan of a state, so it is read only when the map does not know the state.
- Clocks are wall clocks to the minute with no zone, so they stay `local_time`.
- A warehouse is named by its town, which is kept. Its code and contact details are not.
- The delivered scan's remarks open a proof of delivery that names the person who received the
  parcel. It is removed from the page before anything is read, and remarks are never read.
- The estimate's day is kept until the delivery; the time it gives is not. The sender's
  reference and the progress bar are not kept.

## Limitations

- No provider codes, offsets, weight, service or proof of delivery.
- The adapter asks only for twelve-digit numbers.

## Numbers

Customers quote twelve-digit shipment codes in complaints, and the portal's form gives
twelve-digit examples. Many carriers issue twelve bare digits, so no rule claims them.

## Links

The tracking page at `portal.logisimple.pt/pt/tracking` (or `/en/tracking`) opens one shipment
from its `tracking` parameter.

## Testing

`npm run test:carriers:live -- carriers/logisimple`, with `LOGISIMPLE_TRACKING_NUMBER` and
optionally `LOGISIMPLE_UNKNOWN_NUMBER` set outside the repository.
