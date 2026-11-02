# MRL Global

MRL Global is an Australian freight carrier that also trades as MRL Logistics and Sampson
Express, with depots in New South Wales, Victoria, Queensland and South Australia. Tracked
through its tracking page.

## How it works

1. `direct`: one `GET https://www.mrlglobal.com/tracking/?connoteno={number}`, the address the
   page's search form opens. It needs no cookie, key or browser. The WordPress page looks the
   consignment up on the server and renders it.
2. `retry`: the request once more after a network failure or timeout. The first try gets half
   of the budget.

- An unknown number is HTTP 200 with `No details Found` and `Error : Invalid Connote number`.
  That answer repeats no number and is bound to the request alone. Another error line is a
  failed lookup, and the empty form means the page was not given the number. A 404 or a
  redirect is a moved route.
- A consignment's page repeats the number in the address, its first letter capitalized, in its
  box and in every row. Both must match the whole number.
- Cloudflare, in front of the site, could put a browser check in place of the page; that is a
  challenge. The package's default User-Agent passes.
- No detection rule offers MRL Global numbers, so the adapter has no recognition.

After an identified browser challenge, `trawl` opens the same tracking address in the
configured browser service. The carrier parser checks the whole shipment identity.
Definite answers, rate limits and malformed replies do not launch a browser.

## Notes

- The history is grouped by event label and then by day, newest first within a group, but the
  groups follow neither the clocks nor the progress. The adapter sorts the rows by their clocks
  and keeps a row repeated for another item once.
- Rows show a label, not the code the track-and-trace API documentation gives each stage, so
  the labels stage them. `Other Scan` is a handling scan seen all along a consignment's way.
- A depot scan reads `Scanned in Depot (<depot>)`. The depot becomes the scan's location; the
  brackets can be empty.
- The page's `Last Recent Update` gives the current label and clock.
- Clocks are wall clocks to the minute with no zone. MRL Global's depots span several zones,
  Queensland's without daylight saving time, and the page does not say whose clock it shows,
  so they stay `local_time`.
- The page shows the sender's reference, who signed, a quantity per row, a progress picture and
  two columns headed From and To. None is kept; no reply seen filled the last two.
- The API the documentation describes needs a customer account, so the adapter does not use it.

## Limitations

- No estimate, weight or proof of delivery, and no delivery time as an instant.
- Cloudflare caches the page for up to ten minutes, so a fresh scan can show late.
- `Onforward Scan to an agent` hands a consignment to another carrier without naming it or its
  number, so there is no hand-off.

## Numbers

MRL Global tracks freight by consignment note number. Its tracking page and its track-and-trace
API documentation show ten-character numbers: four letters starting with C, then six digits. No
rule claims them: the layout falls inside C-chez-vous' ten-character rule, and two samples
cannot show whether the three letters after the C are a fixed range. The adapter takes only
that layout.

## Links

The tracking page opens one consignment from its `connoteno` query parameter.

## Testing

`npm run test:carriers:live -- carriers/mrl-global`, with `MRL_GLOBAL_TRACKING_NUMBER` and
optionally `MRL_GLOBAL_UNKNOWN_NUMBER` set outside the repository.
