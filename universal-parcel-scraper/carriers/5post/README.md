# 5Post

5Post (5Пост) is X5 Group's delivery network in Russia. Online shops, marketplaces and people
sending each other parcels use it to deliver to pickup points at the tills of X5's shops, such
as Pyaterochka, and to parcel lockers. Tracked through the guest lookup of its app.

## How it works

1. `direct`: `GET https://api-omni.x5.ru/five-post-mobile-api/v3/mobile/order-tracking/{number}/orders`
   lists the orders under the number, as the app `ru.x5.omni` does when someone tracks a number
   without signing in. Two requests then read that order in parallel:
   `GET …/order-tracking/{number}/orders/{orderId}` for its details and
   `GET …/orders/{orderId}/status-history` for its statuses, oldest first. None needs a key,
   token, cookie or captcha. A request that fails to reach 5Post is sent once more within the
   budget.

- An empty list is the app's "no such order in the system", so the number is not found. A 404
  or a redirect on the list is a moved route. A 404 for an order the list just named is
  inconclusive.
- 5Post matches the number whole and in upper case; it finds nothing for lower case.
- The list and the details must carry the whole number, and every status row the order's id.
- ServicePipe fronts X5's hosts. Its check page, even with HTTP 200, is a challenge.
- The website's tracker sends its search with a reCAPTCHA token, and asks for the recipient's
  phone digits when several orders share the number. The app's lookup asks for neither.

## Notes

- Each status's `changeDate` is an instant with its offset, so the events keep `time`.
- The order's `orderStatus` decides the stage and the status text, as the app heads the order
  with it. It can be newer than the history's last row. A row keeps 5Post's own wording, which
  names the warehouse in `Обрабатывается на складе РЦ …` and `Покинул склад …`; that name is
  the event's place.
- `DELIVERED` is the arrival at the pickup point or locker, and `DONE` the collection. A parcel
  left past its storage deadline turns `UNCLAIMED_…` and goes back, which is a return, though
  5Post can send it to a pickup point again. A cancelled order that 5Post already had goes back
  too. `UNDEFINED` ("В работе") and `COMPLETED_BY_PARTNER` say nothing of where the parcel is,
  so they have no stage.
- The pickup point's name and address are kept while the parcel waits there and once it was
  collected there. The storage deadline, the sender, sums, payment options, opening hours,
  location ids and the customs broker's contacts are not kept. A guest gets no recipient
  details and no pickup codes.
- Shops choose their own order numbers, so two shops' orders can share one. The app then lists
  both and the website asks for phone digits. The adapter cannot tell them apart, so such a
  lookup is inconclusive.

## Limitations

- No delivery estimate: the website shows one, but the app's guest reply has none.
- A number that several orders share is inconclusive.

## Numbers

5Post's tracker asks for the order number the shop gave, so its numbers follow each sender.
Archived lookups on the tracker and a public complaint show fourteen digits starting `9999`,
`9988` or `9911`, some of them opened from AliExpress order pages, `P` and eleven digits from
Avito, and `BX`, fourteen digits and `FRW`. Lookups also show other shops' order numbers. No
rule claims any of them: the digit runs share their shape with other carriers, and the other
families belong to senders whose parcels may travel with other carriers. The adapter takes
three to forty letters and digits, as the app asks for at least three. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

`fivepost.ru/tracking?id={number}` redirects to `/tracking/?id={number}`, which looks the
number up and shows the order, or says that no order has that number.

## Testing

`npm run test:carriers:live -- carriers/5post`, with `FIVEPOST_TRACKING_NUMBER` and optionally
`FIVEPOST_UNKNOWN_NUMBER` set outside the repository.
