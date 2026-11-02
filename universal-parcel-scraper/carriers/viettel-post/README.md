# Viettel Post

Reads a Viettel Post shipment record through its legacy text-CAPTCHA lookup.

## Retrieval

The [public tracking client](https://viettelpost.vn/viettelpost-iframe/tra-cuu-hanh-trinh-don-hang)
contains the legacy `api.viettelpost.vn/api/orders/getCaptcha` and `viewTrackingOrders` flow.
Each lookup opens a fresh cookie jar, reads the text image with the bundled local
[OCR model](../../core/transport/text-captcha-model/README.md) and submits its id, answer and one whole waybill. One fresh
challenge is allowed after unreadable text or an explicit rejected answer. Changed payloads,
limits and blocked pages do not become not-found.

The record must repeat the requested waybill in `MA_KIEN`. Its wording, status clock,
provider code and service name are retained. The clock keeps its local wall time.

## Limitations

This is a partial record, not the current tracker's history. It can still show registration
after delivery. Every answer is `summary_only`, so enabled universal providers are asked for
richer and newer history. Recipient details, office addresses and verification state are omitted.

The current tracker and the Android app `com.viettel.ViettelPost` require reCAPTCHA for
their guest history endpoints; neither is used. No cheap recognition solves a CAPTCHA.
Overlapping numeric shapes do not establish carrier ownership. Existing order-page links
can be read, but the signed-in page is not built as a public tracking address.

## Testing

`npm run test:carriers:live -- carriers/viettel-post`. Set `VIETTEL_POST_TRACKING_NUMBER`
to read a known record and `VIETTEL_POST_UNKNOWN_NUMBER` to check an unknown waybill.
