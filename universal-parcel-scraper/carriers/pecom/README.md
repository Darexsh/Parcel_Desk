# PEC

PEC (ПЭК, Первая экспедиционная компания) is a Russian freight forwarder that carries
consolidated cargo between its own terminals in Russia, Kazakhstan and Belarus, with pickup
points and door delivery at the end. Tracked through the lookup its tracking page makes for a
cargo's details.

## How it works

1. `direct`: one `POST https://pecom.ru/ajax/` with the JSON-RPC body
   `{"jsonrpc":"2.0","method":"LK.OCR.Get","sessid":"…","params":{"cargoIndex":"{number}"}}`,
   as the tracking page sends it. The page sends its session's `sessid`; the lookup does not
   check it, so the adapter sends thirty-two zeros and needs no cookie, key or browser. The
   reply has the cargo with its departments, its client statuses and its transit rows. A
   request that fails to reach PEC is sent once more within the budget.

- An unknown code is HTTP 401 with error `-33000`, "Запрашиваемый Вами груз … не найден", so it
  is not found. JSON-RPC's own errors are a changed request, and other errors are inconclusive.
- pecom.ru sits behind Qrator. A page loading `/__qrator/qauth.js`, or a 401 that is not JSON,
  is a challenge, never a missing cargo. A redirect is a moved route.
- The cargo must carry the whole code asked, as its code or its barcode.

## Notes

- Clocks are the department's wall clock to the second, with no zone. Russia spans eleven
  zones, so they stay `local_time`. A status PEC records as a day only comes with the day's
  last second, and keeps only the day.
- A client status without an actual clock is one the cargo has not reached and is not kept.
  The arrival's corrected or planned date is the forecast the page shows, kept as
  `expected_delivery` until the cargo arrives.
- Acceptance and documentation happen at the sending department and arrival and collection at
  the receiving one, so those statuses take that department's town and coordinates. The
  statuses for transit and door delivery name no place.
- The transit rows are worded as the page words them, such as "Отправлен на терминал выдачи"
  and the terminal. An arrival happens at its terminal; a dispatch only names where the cargo
  goes. The arrival at the receiving terminal repeats the client status, so the page leaves it
  out and so does the adapter.
- The current client status decides the stage. "Прибыл" says the cargo reached the terminal
  or pickup point, not that it can be collected, so it stays in transit. "Выдан получателю" is
  a collection and "Доставлен получателю" a door delivery.
- A cargo without a door delivery is collected at the receiving department, whose name and
  address are the pickup point.
- Sender and recipient, their contacts, the payment, the cargo's contents, volume and pieces,
  and the departments' hours and phones are not kept.

## Limitations

- No scan clocks as instants.
- Only the cargo's code finds it; a piece barcode is not found.

## Numbers

Archived lookups on PEC's tracker use twelve-digit cargo codes, sometimes typed in groups of
four; the adapter takes them with or without the spaces. PEC's API documentation also gives a
thirteen-digit cargo code, which the tracker does not find, and piece barcodes add four digits
to the cargo barcode. These digit runs are shared with many carriers, so no rule claims them.
PEC also writes cargo codes as Cyrillic route letters, a sequence number and a day and month,
such as a code ending in `-1/1102`. The library accepts only Latin letters and digits, so those
codes are not supported. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker's structured data gives `pecom.ru/services-are/order-status/?code={number}`, which
opens one cargo.

## Testing

`npm run test:carriers:live -- carriers/pecom`, with `PECOM_TRACKING_NUMBER` and optionally
`PECOM_UNKNOWN_NUMBER` set outside the repository.
