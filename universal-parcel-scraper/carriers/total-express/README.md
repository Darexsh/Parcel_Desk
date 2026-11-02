# Total Express

Total Express is a Brazilian e-commerce carrier. It collects parcels from online shops and
marketplaces such as Amazon, moves them between its bases across Brazil and delivers them
itself, or hands some to Correios. Tracked through the API its tracking page reads.

## How it works

1. `direct`: one `GET https://totalconecta.totalexpress.com.br/mfe-rastreio/api/order-data?awb={number}&language=pt`,
   the read the tracking page makes for a parcel it found. It needs no cookie, token, key or
   browser. The JSON reply has the shipment's summary and its scans under four milestones.

- An AWB the tracker does not know fails with HTTP 500, which a parcel it knows can also give.
  The adapter then asks the page's search, `GET …/basic?code={number}&limit=10&page=1`. An empty
  page of results is not found; a result with the AWB leaves the failure inconclusive. The
  search also matches order and invoice numbers, so only a result with the AWB asked counts.
- Akamai, in front of the site, answers many networks with an Access Denied page, which the
  adapter reports as a challenge. It answers a client it does not take for a browser with HTTP
  400 and a JSON message asking for a User-Agent, also a challenge. A User-Agent that names no
  browser, such as curl's, gets the site's page for too many requests, which the adapter reports
  as rate limited. The package's default User-Agent passes.
- The shipment must echo the AWB asked.
- Recognition makes the same requests.

## Notes

- Each scan's `data` and `hora` are a wall clock to the second, with no zone. Total Express's
  bases span Brazil's time zones, and the reply does not say whether a clock is the base's or
  the system's, so the clocks stay `local_time` rather than gaining an invented offset.
  Consumers read them in the catalog's zone, São Paulo's.
- A scan's description is its own Portuguese wording, `statusDescricao`, such as
  `TRANSFERENCIA PARA: SGE`, without the empty separators the tracker leaves around a base's
  code. Those three-letter codes name Total Express's bases rather than places, so scans have no
  location. The page shows a friendlier message per milestone instead; the adapter keeps neither
  those messages nor the milestone names.
- The status id, `statid`, stages a scan. The ids and their labels come from the list the page
  bundles. Waiting to be measured and other bookkeeping move nothing. `EM ROTA` puts the parcel on
  a delivery round at the delivery base; `PROCESSO DE ENTREGA` follows when the driver takes it.
- The page lists each milestone's scans newest first. The adapter sorts all scans by clock, puts
  a later milestone's scan first at the same second, and keeps a repeated scan once.
- The merchant the reply names is the sender. The delivery estimate is a calendar day, kept until
  a delivery or a return.
- When Total Express hands a parcel to Correios, the reply gives the Correios number, which
  becomes the delivery partner's number. The pickup point the reply names for a parcel waiting
  there is kept.
- The order and invoice numbers in the reply are not kept. The reply has no recipient details.

## Limitations

- No location, weight or service, and no delivery time as an instant.
- From a network Akamai turns away, the lookup ends as a challenge.
- The tracker also finds parcels by their order and invoice numbers, which are not tracking
  numbers. Merchants' addresses for the older tracker carry a merchant key with the order.

## Numbers

Total Express AWBs are four letters, nine digits and `TX`, which the tracker writes in lower
case: `TXAQ` and `TXAS` for most shops, and `AMZB` for Amazon. No other carrier's numbers have
this shape, so `total-express-awb` claims `TX` with two letters, and `AMZB`, before the digits.
The former tracker used ten digits, as in the example of an open-source scraper of it. Ten
digits are shared by DHL and several other carriers, so no rule claims them, and the adapter
does not take them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking page's address for one parcel, `/rastreamento/rastreamento/encomendas/{AWB}`, and
its search address with `?codigo={AWB}` name the AWB. The link the package builds opens the
search with the AWB filled in. A search address with an order or invoice number names no
carrier.

## Testing

`npm run test:carriers:live -- carriers/total-express`, from a network Akamai lets through, with
`TOTAL_EXPRESS_TRACKING_NUMBER` and optionally `TOTAL_EXPRESS_UNKNOWN_NUMBER` set outside the
repository.
