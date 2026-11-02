# Cruz del Sur

Cruz del Sur is an Argentine freight and parcel carrier with its own network of branches across
the country, which also delivers online shops' orders. Tracked through its tracker's result
page.

## How it works

1. `direct`: one
   `GET https://www.cruzdelsur.com/herramientas_seguimiento_resultado.php?nic={number}`. The
   tracker renders the shipment on the server: the NIC, a panel with the loading date, the
   sender, the recipient and their branches, and the tracking line, oldest event first. It
   needs no cookie, token, CAPTCHA or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- The search form on `herramientas_seguimiento.php` checks a reCAPTCHA through
  `_post/ajax.php` and then opens this page, which does not check it again.
- A NIC the tracker does not hold gets "No existe NIC." in place of the shipment, which is the
  only missing shipment. A shipment without events is no history. A redirect, a 404, another
  notice, a page without the tracking line and a page for another NIC are no answer. The search
  form and block pages are challenges, and rate limits and other HTTP errors keep their own
  failure kinds.
- The page must show the NIC asked. The tracker reads it as a number and shows it without
  leading zeros.
- Recognition makes the same request.

## Notes

- Each event has a numbered heading, a day, usually a clock to the minute, and the branch, which
  is its location. The clock is Argentine wall time without an offset and stays `local_time`;
  an event without a clock keeps its day.
- The headings are fixed wordings, staged through [status.ts](status.ts); wording the map does
  not know goes to the shared wording rules.
- The panel's loading date, the sender's and recipient's names and their branches and town are
  not kept.

## Limitations

- No delivery estimate, weight, service name or proof of delivery, and no instants.
- Old NICs, such as those of the help illustrations, get "No existe NIC.".

## Numbers

Cruz del Sur tracks a shipment by its NIC, the internal control number printed on each label
and consignment note. Its own help illustrations print it as seven digits, a hyphen and two
digits; the adapter takes the nine digits. Short digit groups like these are not unique to Cruz
del Sur, so no rule claims them and recognition is not asked about them. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The result page takes the NIC as `nic`, so its address opens one shipment.

## Testing

`npm run test:carriers:live -- carriers/cruz-del-sur`, with `CRUZ_DEL_SUR_TRACKING_NUMBER` and
optionally `CRUZ_DEL_SUR_UNKNOWN_NUMBER` set outside the repository.
