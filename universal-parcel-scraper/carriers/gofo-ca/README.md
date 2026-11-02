# GOFO Canada

Tracks individual Canadian parcels through GOFO Canada's official anonymous
tracking service. Links to gofo.com's `/ca` pages name this carrier.

## How it works

GOFO Canada runs [GOFO US](../gofo/README.md)'s consignee service at its own
`/ca` path, and the adapter shares GOFO US's tracker and parser. One bounded
JSON POST asks for Toronto clocks. Waybills are `GFCA` and 14 digits; detection
claims them.

The reply sorts unknown numbers by the region their prefix names. Only the
Canadian error list proves absence; the US service files a `GFCA` number under
it as another region's, so that answer stays inconclusive.

## Notes

As on GOFO US, each requested clock must carry Toronto's offset at that time,
and the instant is expressed in the scan's own zone when GOFO names a valid
one. The label is dated on Eastern time. Scan codes and wording are GOFO US's,
so the two carriers share one status map.

## Limitations

Delivery prose, proof images, weight and estimates are left out, as on GOFO US.

## Testing

Set `GOFO_CA_TRACKING_NUMBER` outside the repository, optionally with
`GOFO_CA_UNKNOWN_NUMBER`, and run
`npm run test:carriers:live -- carriers/gofo-ca/adapter.live.test.ts`.
