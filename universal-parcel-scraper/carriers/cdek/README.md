# CDEK

Tracks CDEK orders through the guest lookup that CDEK's app and its order page on `my.cdek.ru`
use.

## How it works

The app and the page at `my.cdek.ru/lkfl/order/{number}` ask the same service,
`GET https://my.cdek.ru/api/lkfl/v3/tracing/trackInfoBeta/{number}`. It needs no account, key,
cookie or phone confirmation, and it accepts a plain client. The tracker on `www.cdek.ru`, and the
sites for Kazakhstan and Belarus, sit behind ServicePipe's bot check, which shows a headless
browser a CAPTCHA, so the adapter does not use them. A request that fails to reach CDEK is sent
once more within the budget.

A number the service does not know comes back as HTTP 404 with the code
`tracing.cant_determine_order`, so it is not found; any other 404 is a transport failure. The
service's tracking limit and HTTP 429 are rate limits, its "try again later" is inconclusive, and
ServicePipe's page is a challenge, even with HTTP 200. Other HTTP errors and malformed replies
keep their own failure kinds. Recognition uses the same lookup.

## Numbers

The adapter takes 5 to 40 letters and digits, as the app checks them. CDEK's own order numbers
are ten or eleven digits, and the reply must name the whole requested one. CDEK also finds an
order by another number it links to it, such as the international postal number of a parcel from
abroad, and answers with the order's own number, which becomes `canonical_tracking_number`.
Eleven-digit numbers are shared with several carriers. CDEK's own count up from `10`, as its
public numbers do, so detection offers CDEK beside the others for an eleven-digit number starting
`10` and claims none of them. A ten-digit number is offered to nobody, and the adapter answers when
a parcel is filed under CDEK.

## Notes

The reply lists the order's milestones, such as created, in transit, with the courier, ready for
pickup and delivered. Each has a code, Russian wording and a clock, and holds its scans grouped by
city. The adapter reads every scan, and a milestone without scans as an event of its own. It
keeps CDEK's code, maps it and gives the city as the place. Milestones the order has not reached
yet are marked as future, as the app reads them; they are not scans and are left out. Clocks are
UTC instants. "Не вручён", the end of an order that did not reach its recipient, is
an exception.

ParcelsApp relays CDEK's scans as labels naming the leg of the trip, such as "Принят в городе
отправителя" and "Вручено", without a code. A scan filed under CDEK's name takes its stage from
these labels and keeps the relayed wording.

The recipient's initials, the addresses, the offices with their phones, hours and coordinates,
the courier's agreed slot, the storage deadline, payments and pickup codes are not read.

## Limitations

The anonymous reply hides what CDEK shows only to the signed-in recipient, such as the pickup
code. The adapter reads no delivery estimate, weight or proof of delivery. Future milestones, the
service's tracking limit and "try again later" answers, and its replies for other services'
numbers were not seen live; the adapter follows the app's code for them. Orders handled in
Kazakhstan and Belarus were not checked.

## Testing

Set `CDEK_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/cdek/adapter.live.test.ts`.
Optionally set `CDEK_UNKNOWN_NUMBER` to check a number the service does not know.
