# CORRE

CORRE, Correio Expresso de Moçambique, is Mozambique's designated postal operator and took
over the universal postal service from Correios de Moçambique. Tracks the items CORRE registers
itself through its national lookup on corremz.com.

## How it works

1. `direct`: one `GET https://www.corremz.com/cgi-bin/tracktrace.cgi?OBJ={number}`, the page the
   Track & Trace section of corremz.com opens for a national item. It needs no account, cookie,
   token, key or browser.
2. `retry`: a lookup that fails to reach the site, or hangs, is sent once more within the budget.
   The first try gets half of the budget.

- The page is HTML with a table for each record the lookup holds for the item: the record's
  wording beside the item's code, then labelled cells. The code must be the whole requested one;
  a record for another code is inconclusive.
- A code the lookup holds nothing for gets the same page without a table, still ending with the
  time the search took; only that page is not found. A page without either is a changed reply.
  A code that is not thirteen characters long gets a refusal, which is invalid input.
- A 404, a 410 or a redirect is a moved route, and a firewall page is a challenge.
- Recognition makes the same request. A code ending `MZ` with a valid check digit suggests
  CORRE, so preflight asks it first.

## Notes

- The adapter sends only S10 codes ending in `MZ` with a valid check digit, though the lookup
  takes any thirteen characters. It holds the items CORRE takes in, one sent abroad included;
  CORRE's site looks up mail from abroad on the UPU's Global Track and Trace.
- A record's `DATA` is a clock to the minute with no zone, such as `202603110914`. The record
  seen falls before CORRE's counters open at eight if read as Maputo time, and just after if read
  as UTC, so the clock stays `local_time`.
- The wording names the record, such as `GUIA RECEBIDA` when a counter takes in the waybill and
  the item. Mapped wording sets the stage; other wording goes to the shared rules.
- `NO`, the system's name for the counter, is not a place, and `USER` is the clerk's login, so
  neither is kept. The page also links a scan of the waybill, which the adapter never asks for.
- The page names no charset. It is read as UTF-8 when it decodes as such, else as the
  windows-1252 of the site's other pages.

## Limitations

- The lookup has no location, ETA, service, weight, destination, sender, recipient or proof of
  delivery, and no clock with a zone.
- The only record wording seen is the waybill taken in at the counter.
- Mail from abroad is not tracked here.

## Numbers

CORRE's EMS and postal items carry UPU S10 numbers ending in `MZ`. Generic postal detection
keeps these numbers, since the issuer of an S10 code does not establish who delivers it;
`corre-s10` only suggests CORRE, which recognition asks first. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

The search page's form sends the same `OBJ` parameter to `/cgi-bin/trace.cgi`, which answers
like `tracktrace.cgi`; the library reads a number from either address.

## Testing

`npm run test:carriers:live -- carriers/corre`, with `CORRE_TRACKING_NUMBER` and optionally
`CORRE_UNKNOWN_NUMBER` set outside the repository.
