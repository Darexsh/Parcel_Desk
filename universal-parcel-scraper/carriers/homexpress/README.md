# HOMEXPRESS

HOMEXPRESS is a Sydney courier that delivers e-commerce parcels, such as SHEIN orders, to homes
in Australian cities with its own drivers. Its tracker is the trace tracker of EWE Group's
delivery system on HOMEXPRESS's own host. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.homexpress.com.au/api/trace/orderRoute?orderNo={number}`, the
   request the tracking page's script makes. It needs no cookie, token, key or browser. The JSON
   reply lists the parcel's scans, newest first, each with an `action` code, its time in UTC with
   the site's offset, and the suburb. The client and parser are shared with EWE's trace tracker
   ([trace.ts](../ewe/trace.ts)).
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- An unknown number is HTTP 200 with code 404 and `订单不存在` ("order does not exist"), which
  the page reports as not found. Another code is inconclusive, and so is a reply without scans.
- A 429 is a rate limit, a 403 or a bot check a challenge, and a redirect or a 404 a moved route.
- Every scan must name the whole number asked.
- The server sends its certificate without the intermediate, Sectigo Public Server
  Authentication CA DV R36, which Node does not fetch. Over the global fetch the adapter trusts
  that intermediate, which [certificate.ts](certificate.ts) holds; a host's own fetcher is used
  as given and has to trust the chain itself.
- No recognition: no rule claims HOMEXPRESS's numbers.

## Notes

- One server answers HOMEXPRESS's tracker and EWE's trace tracker from one database, so each
  knows the other's parcels. A history found here does not show which of them delivers.
- Scans keep their instant with the site's offset; the reply's wall clock must agree with it.
- A scan is staged by its `action` code, which the tracking page's own script also reads for a
  delivery. A code the map does not know falls to the shared wording rules.
- The out-for-delivery scan names the driver, whose name is dropped, as are phone numbers. The
  suburb and state are kept as the location, though the page does not show them. The postcode,
  the delivery coordinates and proof photos are not.
- The reply names no other carrier or number, so there is no hand-off.

## Limitations

- No delivery estimate, weight or service name.
- The intermediate certificate expires in March 2036. A certificate HOMEXPRESS takes from
  another intermediate is refused with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` until that one is added.

## Numbers

No public source shows a whole HOMEXPRESS number, and the tracking field's example is one of the
page's simulated orders. The page sends whatever is typed, so the adapter takes four to forty
letters and digits, in capitals. No rule claims a layout and detection does not offer
HOMEXPRESS.

## Links

The tracker looks the number up from its search field and reads none from its address, so no
link opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/homexpress`, with `HOMEXPRESS_TRACKING_NUMBER` and
optionally `HOMEXPRESS_UNKNOWN_NUMBER` set outside the repository.
