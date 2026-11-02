# HCT Logistics

HCT Logistics (新竹物流) is a Taiwanese freight and parcel carrier that delivers business and
home parcels across Taiwan through its branches and depots. Tracked through the search page
its Android app opens.

## How it works

1. `direct`: three requests to the app's search page, `https://www.hct.com.tw/app/`. A
   `GET searchGoods_index.aspx` returns its WebForms form and state. A `POST` of that state,
   with the number in `txtpKey2` and `Button1` as the event target, is what its search button
   sends. The answer is a script that opens `searchGoods_Main.aspx` with the number the server
   encrypted and its key, and a `GET` of that page returns the scans, newest first. It needs no
   cookie, picture code, app key or browser.
2. `retry`: the same requests once more after a network failure or timeout. The first try gets
   half of the budget.

- The website's own form asks for a picture code. The app's barcode scanner encrypts the
  number itself before opening the result page; the search page has the server do it, so no
  key is needed.
- The script writes the Base64 ciphertext raw. The adapter encodes it, so a `+` does not reach
  the server as a space.
- A number without scans gets the page's own notice that it has no delivery data
  (`查無此配送資料`), with no number echoed. That is read as not found. Any other notice in its
  place, such as the one for a ciphertext the server cannot read, is a broken reply.
- The pages answer with HTTP 200. A redirect or a 404 is a moved route or an error page. A page
  without its fields is a changed page, or a challenge when it carries a Cloudflare check or a
  firewall refusal. Every page loads Cloudflare's beacon script, which is not a check.
- The result page must echo the number asked.
- Recognition makes the same requests. No detection rule offers HCT, so recognition is not
  asked until one does.

## Notes

- Each scan's clock is the day and minute HCT entered it, with no zone. HCT delivers only
  within Taiwan, which has one zone without daylight saving, so clocks are read in Taipei time.
  A pickup notice can carry only its day, which stays a local date.
- A scan's description is HCT's sentence, which names the branch or centre in charge, as in
  `貨件已抵達…營業所，分貨中。`. The sentences carry no code; their form stages them, following
  the labels HCT's website gives the same scans, such as `已集貨` for a branch's first scan and
  `暫置營業所` for a parcel kept between legs. A call nobody answered and a pickup moved to
  another time have no stage.
- The location is the branch or centre the sentence names. Its link to the branch's phone
  number is not kept.
- HCT issues numbers again. The app's page keeps listing the scans of a number's earlier use,
  which HCT's website leaves out, so scans more than ninety days older than the next one are
  dropped. The pickup notice the page lists after the scans takes its place by its clock, and a
  row listed twice is kept once.

## Limitations

- No estimate, weight, service, recipient or proof of delivery. The piece count stays in the
  sentence.
- The app's global search, by order number and recipient phone, is not used.

## Numbers

The tracker asks for a ten-digit cargo or bill-of-lading number (10碼貨號/提單號). On every
sample the last digit is the remainder of the first nine divided by seven. DHL Express waybills
carry the same check, so no rule claims these numbers.

## Links

None. The website's tracker posts its form behind a picture code, the app's result address
holds a server-encrypted number, and the older `SearchGoods.aspx` address, which carried the
number in Base64, now redirects to the home page.

## Testing

`npm run test:carriers:live -- carriers/hct-logistics`, with `HCT_LOGISTICS_TRACKING_NUMBER` and
optionally `HCT_LOGISTICS_UNKNOWN_NUMBER` set outside the repository.
