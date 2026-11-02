# Kunyoung Express

Kunyoung Express (건영택배), run by Kunyoung Cargo (건영화물), is a South Korean parcel carrier
based in Daegu. Its branches and terminals deliver across Korea, including parcels other
carriers hand over to it. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://mj.kunyoung.com/webinvoicetracehistory/selectListInvoiceTraceHistory.do`
   with the number as the multipart form field `invoiceNumber`, as the tracking page on
   `mj.kunyoung.com`, which the home page's waybill search opens, sends it. It needs no cookie,
   token, key or browser. The JSON reply lists the parcel's scans, newest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with `msgCode` `0` and no rows, which the page reports as a
  waybill not registered yet. Another `msgCode` is an error the page shows instead of a result,
  so it is inconclusive. A 404, a 410 or a redirect is a moved route.
- The reply does not repeat the number. The service matches only the whole number: a
  hyphenated number, a shorter one or one with a digit added is not found. The adapter sends
  whole ten-digit waybills only, so the request binds the reply to the number.
- Recognition makes the same request.

## Notes

- Each scan's `writeDate`, the clock the page shows, is a wall clock to the second with no zone.
  Kunyoung scans and delivers only in Korea, which keeps UTC+9 all year, so the clocks are read
  in `Asia/Seoul` and each scan gets a `time`, and a delivery a `delivered_at`.
- A scan's one-letter `goodsTypeSP` code, such as `Y`, is its `provider_code`, and its status
  line, such as `배송을 완료하였습니다.`, its description. The map stages the codes seen live and
  their lines. The page's script also handles `G` and `N`, which were not seen; such a scan is
  kept without a stage, and an `N` scan's details come before its line, as the page shows them.
- A scan's site is its branch or terminal. A delivery can name the agency that delivered it,
  such as a partner carrier's branch, without that carrier's number.
- The driver's name and phone number, the delivery photo, the vehicle plate and the staff ids
  in the reply are not kept, and a site that names a person is dropped.

## Limitations

- No delivery estimate, weight, service or pickup point.
- The older waybill pages on `kunyoung.com` read another record and do not know parcels the
  current tracker lists; the adapter does not ask them.

## Numbers

Kunyoung Express prints ten-digit waybill numbers; its lookup asks for ten digits without
hyphens. Many Korean carriers print the same digit runs, so no rule claims them and preflight
does not ask the adapter. The sample and its source are in [`numbers.json`](numbers.json).

## Links

`mj.kunyoung.com/?invoiceNumber={number}` fills the tracking field and runs the lookup. The
older waybill pages on `kunyoung.com`, `goods/goods_01.php` and `goods_01__.php`, read `mulno`
and list the parcel, and `goods_02.php` and `goods_02__.php` with the same parameter show its
history.

## Testing

`npm run test:carriers:live -- carriers/kunyoung`, with `KUNYOUNG_TRACKING_NUMBER` and
optionally `KUNYOUNG_UNKNOWN_NUMBER` set outside the repository.
