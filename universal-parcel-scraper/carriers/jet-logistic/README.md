# Jet Logistic

Jet Logistic (Джет Логистик) is a Kazakh transport company that carries cargo and parcels from
Russia to Kazakhstan with its own vehicles, warehouses and branches, and buys goods in Russia
for its customers. It also has offices in Russia, Kyrgyzstan and Belarus. Tracked through the
cargo check on its site.

## How it works

1. `direct`: one `POST https://jetlogistic.kz/ajax/checkstatus.php` with the form field
   `TID={number}`, as the cargo check on every page of the site sends it. It needs no cookie,
   token, key or browser. The JSON reply's `answer` is the cargo's status as text, one line per
   step, oldest first.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An unknown cargo is `success` 0 with a message naming its request number, the last seven
  digits of the cargo ID. Another message is inconclusive.
- The service finds a cargo by those seven digits alone and names the whole cargo ID in its
  answer, so the answer must name the ID asked.
- Recognition makes the same request.

## Notes

- A step's line has its wording, the warehouse's town and region, and a wall clock that names
  no zone. The network spans several time zones, so the events keep `local_time`. The handing
  out is dated by its day alone.
- Arrival at the issuing warehouse stays in transit: a door delivery can still follow it.
- The page also sends `check_pay`, which adds the payment link it shows for an unpaid cargo;
  the adapter leaves it out. The kind of goods, the cost of the service and the payment dates of
  goods Jet Logistic bought for the customer are not kept.

## Limitations

- No estimate, weight, sender, recipient or proof of delivery.
- The page's further details sit behind a form that asks for a phone number, and are not read.

## Numbers

The tracker asks for the cargo ID. Customers quote it on Jet Logistic's reviews page as a cargo
code, cargo, waybill, order or request number, always twelve digits. Twelve bare digits are the
waybill shape of many carriers, so no rule claims them, and a lookup reaches the adapter only
when the caller names Jet Logistic. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The cargo check on every page posts the number to the site's lookup and shows the history in
a pop-up, so no address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/jet-logistic`, with `JET_LOGISTIC_TRACKING_NUMBER` and
optionally `JET_LOGISTIC_UNKNOWN_NUMBER` set outside the repository.
