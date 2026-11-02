# Pargo

Pargo parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Pargo is a pickup-point network in South Africa; couriers carry its parcels to the points. Its
API documentation gives waybill numbers as `PAR` and ten digits, which `pargo-1` claims.
Magyar Posta's broad domestic rule also matches them with low confidence. Shops that send
through Pargo get tracking codes that start with their own prefix, and Pargo's earlier tracker
took eleven-digit waybills. Those shapes name the shop or are shared with other carriers, so no
rule claims them.

## Links

The tracking page, `pargo.co.za/track-trace/`, embeds Pargo's tracker. Archived lookups pass
the number as `code`, and earlier as `track-trace`. Earlier trackers read it from
`trackingCode` on `pargo.co.za/scripts/track_and_trace.php` and from `waybill` on
`api.pargo.co.za/track-trace.php`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
