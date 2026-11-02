# TK KIT

TK KIT (ТК «КИТ») is a Russian freight forwarder that carries groupage cargo between its own
terminals in Russia, Kazakhstan, Belarus, Kyrgyzstan and Armenia, with delivery to an address
or a pickup point at the end. Tracked through its tracking page's own lookup.

## How it works

1. `direct`: `GET https://tk-kit.ru/tracking` opens a session. The page carries Yii's CSRF
   token in its `csrf-token` meta tag and sets the `_csrf` cookie the token belongs to. Then
   `POST https://tk-kit.ru/site/trackload_end?send=1` with the form the page's script sends:
   `_csrf`, `TrackLoadForm[track_code]` and `TrackLoadForm[skip_converter]=0`, the token in
   `X-CSRF-Token` and `X-Requested-With: XMLHttpRequest`. The reply is the consignment with
   its steps, its route and its receiving terminal.
2. `retry`: one more attempt in a new session when the first fails to reach KIT or hangs,
   inside the budget.

- The page's own request carries no captcha answer, and neither does the adapter's. The
  Yandex SmartCaptcha the page loads guards its feedback form. A captcha or firewall page in
  place of the page or the reply is a challenge, never a missing consignment.
- An unknown number is HTTP 404 with the JSON message "Статусы null", which the page reports
  as "Заказ не найден". Any other 404, or a redirect, is a moved route. Yii's refusal of the
  session's token (HTTP 400, "Не удалось проверить переданные данные") is inconclusive.
- The reply repeats the number sent as `track_code` and names the consignment's forwarding
  receipt, which must end in the same ten digits. A reply listing several consignments to
  choose from is inconclusive.
- Recognition makes the same request.

## Notes

- A step has a date and a time to the second, with no zone and no terminal. Russia spans
  eleven zones, so clocks stay `local_time`.
- Steps are staged by their code, as the page's script lists them. The arrival at the
  consignee's terminal (`03`) is ready for pickup on a route collected there, and in transit
  when the cargo goes on to an address or a pickup point: the page then says it is being
  prepared for that delivery. Such a route has the delivery type `delivery` or `PVZ`, the
  six-step route or an ordered delivery.
- `F1` and `F2` hold the arrival estimate the page shows, not a step, so they are left out.
- Acceptance and dispatch happen at the sending terminal, and the arrival and the handover to
  the driver at the consignee's, so those steps take the route's sending or receiving city. The
  issue takes the receiving city on a route collected at the terminal. The new order and a
  cancellation name no place.
- On a route collected at the terminal, the receiving terminal's address is the pickup point.
- Only the number, the steps, the route's cities, the gross weight and the receiving terminal's
  address are kept; the reply's other details are not.

## Limitations

- No delivery estimate and no scan clocks as instants.
- No pickup point for a delivery to a pickup point.
- The page's notice that the sender has barred issue comes without a step or a clock, and is
  not kept.

## Numbers

A consignment is tracked by its forwarding receipt: six Cyrillic letters, then ten digits. The
tracker also finds it by the ten digits alone. The library accepts only Latin letters and
digits, so the full receipt is not accepted and the adapter looks up its ten digits. Ten
digits are shared by many carriers, so no rule claims them. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

`tk-kit.ru/tracking?track_code={number}` opens one consignment: the tracker page writes the
number into that parameter as it is typed and looks it up on load. The site's earlier direct
tracking links, `tk-kit.ru/?tracking={number}` and the same on tk-kit.com, are read too.

## Testing

`npm run test:carriers:live -- carriers/kit-tk`, with `KIT_TK_TRACKING_NUMBER` and optionally
`KIT_TK_UNKNOWN_NUMBER` set outside the repository.
