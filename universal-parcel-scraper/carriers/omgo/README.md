# OMGO

OMGO Express cross-border shipments are detected locally and tracked through its
anonymous public HTTP form. Universal providers remain available when the consumer
enables them; their evidence belongs in [COVERAGE.md](../../providers/COVERAGE.md).

## Retrieval

The adapter opens a fresh [tracking page](https://omgoexpress.cn/track-package/)
and reads its page-issued nonce. Cached pages can contain an expired nonce, so
each lookup uses a fresh page URL. Its [official client](https://omgoexpress.cn/wp-content/plugins/saralvy-hualei-integration/pages/frontend/assets/js/script.js)
posts the nonce and whole number as multipart `shi_get_tracking_info` to
`/wp-admin/admin-ajax.php`. No account, browser or persistent session is needed.

The response must name the requested shipment. Generic "Tracking Code not Found"
errors remain inconclusive because they carry no shipment identity. They and an
empty result carry the reason `portal_not_found`, so a consumer can tell OMGO's
answer from an outage. Invoice references are discarded.

## Limitations

Detection covers the observed shipment-number shape. Facility clocks have no
verified offsets and stay local, including on cross-border histories. Unloading
at a delivery location does not establish recipient delivery, and a handover
before export does not establish a last-mile delivery run. A delivery partner
remains separate from the OMGO number.

## Testing

`npm run test:carriers:live -- carriers/omgo` accepts `OMGO_TRACKING_NUMBER`
for direct retrieval and recognition, and `OMGO_UNKNOWN_NUMBER` for the
inconclusive error path. Offline tests use synthetic history.
