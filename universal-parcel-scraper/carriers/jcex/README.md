# JCEX

JCEX (佳成国际物流有限公司, Hangzhou Jiacheng International Logistics) sends parcels from China
and hands them to a delivering partner in the destination, such as USPS in the United States.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://track.jcex.com/api/track/tracking` with
   `{"numberList":["<number>"]}`, as the tracking page's script sends it. It needs no cookie,
   token, key, account or browser. The JSON reply holds one entry per number with JCEX's
   waybill and order numbers, the shipment's status and its rows newest first, each in English
   and Chinese with a place, a country and an offset.
2. `origin`: after a connection failure, send the same request to JCEX's origin using a
   request-scoped DNS override. The URL, HTTP host, TLS server name and certificate verification
   remain those of `track.jcex.com`. This uses the supplied Node fetch transport's Undici
   dispatcher support; no global resolver or TLS setting changes.
3. `retry`: one more ordinary connection attempt if the origin also fails to connect.

- The shipment counts only when its waybill or order number is the one asked.
- An unknown number comes back with neither number and the status `NotFound`. A waybill JCEX
  has printed but not scanned comes back with its numbers, the same status and no rows: it has
  no history yet. Any other refusal is inconclusive.
- Redirects are not followed, and a bot check in place of the reply is a challenge.

## Notes

- JCEX files every row under one of 17TRACK's sub-statuses (`platformEventCode`), and the map
  reads that code: JCEX's own event codes group rows of several stages. The origin warehouse's
  "Arrive at the delivery point" is the parcel reaching JCEX, which the shared rules would read
  as a parcel waiting for collection. Rows without a code are read by their wording.
- JCEX files its handover to the delivering partner's depot as delivered too, so
  `Delivered_Other` counts only with wording the shared rules read as a delivery, and the
  handover rows seen are transit. So are the delivering partner's collection and its receipt at
  each transit point, which it files as a pick-up although JCEX took the parcel in long before. Rows seen under a code too broad for them, such as
  Colissimo's failed visit under `Exception_Other`, are mapped one by one.
- Rows come newest first, but JCEX puts its own milestone, such as that handover, on top. The
  rows are ordered by their clocks, and rows at one time keep the reply's order.
- JCEX writes its own rows on Beijing's clock, under China's offset or the destination's. It
  lists a scan it relays from Yanwen or the delivering partner twice: as the source's row under
  the source's offset, and as its own copy, the same instant on Beijing's clock under the same
  code. The copy is dropped, and the source's offset holds for every row under it, wherever its
  place. A scan relayed on Beijing's clock comes twice too, once in JCEX's own words under the
  bare place `CN`, sometimes under another code; that row is dropped and the source's words
  stay. The order data, filed under neither a country nor a place, is on Beijing's clock
  whatever offset it carries.
- Other rows are read on the clock their place keeps: its country's when the country has one,
  and in the United States its state's when the place names one, as USPS writes it. A row whose
  place is a bare country code keeps that country's clock: JCEX files its Hong Kong hub's rows
  under the destination with the destination's offset. An offset the place does not keep at
  that time, and a place without one clock, keep the wall clock: Colissimo's rows come on
  France's clock with China's offset.
- The newest scan's instant, when it has one, is the last update, and a delivered scan's is the
  delivery time. Rows dated after the read are dropped.
- Seconds after it takes a parcel in, JCEX writes a timeline up to the delivering partner: rows
  on one second of the minute, each a whole number of six minutes after the one before. Three
  or more such rows in a row are no scans and are dropped too. So are three or more starting
  within a minute after the receipt, whatever scans fall between them: such a timeline can put
  the parcel through the destination's customs while the warehouse in China is still handling
  it. Their clocks are named in `written_ahead`, or, for an order with nothing else, in its
  error, so that a provider's copies of them are set aside as well.
- The recipient's province, city and postcode, the postcodes in the rows' places, the
  shipment's reference and the delivery estimate are never read.

## Limitations

- No delivery estimate, service, sender, recipient or proof of delivery.
- The delivering partner and its number are not named: the reply leaves them empty.
- A copy listed without the scan it copies keeps the offset it carries, which can be the
  destination's on Beijing's wall clock. The app's scan-identity policy lets that scan take the
  copy's row over once JCEX lists it.
- Other JCEX number layouts are not looked up until one is seen.
- The origin address can change. A custom fetch transport must support the request's
  `dispatcher` option to use the origin fallback. Definite replies, rate limits and browser
  checks are not retried at the origin.

## Numbers

ParcelPanel's JCEX page offers waybills of `JCZ`, ten digits and `DH`, and JCEX's tracker
answers them. `jcex-1` claims that layout.

## Testing

`JCEX_TRACKING_NUMBER=... JCEX_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/jcex`
