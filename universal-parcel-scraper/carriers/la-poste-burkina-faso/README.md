# La Poste Burkina Faso

Tracks La Poste Burkina Faso's S10 items, and the S10 items other posts send to Burkina Faso,
through the IPS Web Tracking page its tracking help page links to.

## How it works

1. `direct`: one `GET http://webtracking.laposte.bf/webtracking/IPSWeb_item_events.aspx?itemid={number}&Submit=Submit`,
   as the tracker's form sends it. It needs no cookie, token, key or browser. A heading names
   the item, which must be the whole requested code, and a table lists its scans, oldest first.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- A code the tracker holds nothing for gets the page's notice "No information, please check
  your item identifier", which is not found. A heading without scans is inconclusive.
- A firewall or bot-check page, even with HTTP 200, is a challenge, a 429 a rate limit and a 503
  maintenance. A 404, a 410, a redirect or a changed page is a moved route or a schema error.
- Recognition makes the same request.

## Notes

- The tracker answers plain HTTP only; nothing answers on HTTPS. The request carries only the
  item code.
- The page heads its clocks "Local Date and Time", day first, to the second. An office in
  Burkina Faso keeps Ouagadougou's clock, UTC all year, so its scans get that offset. A scan
  abroad, such as the destination post's delivery, keeps its wall clock as `local_time`.
- Event names are the UPU IPS system's, mostly with their leg: `(Otb)` in the posting country,
  `(Inb)` in the destination and `(EDI-received)` for a scan another post reported as data. The
  adapter maps the names without their leg. An inward scan gives the destination country.
- The extra information's reason, measure and retention reason follow the event name after a
  colon. The signatory, its image, the next office, the mail category and office postcodes are
  dropped. An office the page names by number only gives just its country.

## Limitations

- No ETA, weight, service or proof of delivery.
- Only items posted in Burkina Faso have been seen live, and their pages listed only the
  destination post's scans. Scans by offices in Burkina Faso follow an archived capture of
  the former host, and mail from abroad, a delivery in Burkina Faso included, has not been seen.

## Numbers

La Poste Burkina Faso, the national post formerly named SONAPOST, gives letters, parcels and
EMS items UPU S10 numbers ending in `BF`. Its tracking help page quotes this layout. Generic
postal detection keeps these numbers, and a code ending `BF` only suggests La Poste Burkina
Faso, which recognition asks first. The
adapter takes S10 codes from any post with a valid check digit; anything else is invalid
without a request.

## Links

The library reads the number from the IPS page's `itemid`, on webtracking.laposte.bf and on
the former webtracking.sonapost.bf host. The tracker is served over plain HTTP only, so the
catalog links neither the tracker nor a search page.

## Testing

`npm run test:carriers:live -- carriers/la-poste-burkina-faso`, with
`LA_POSTE_BURKINA_FASO_TRACKING_NUMBER` set outside the repository to an item the tracker knows.
Optionally set `LA_POSTE_BURKINA_FASO_UNKNOWN_NUMBER` to check a code the tracker does not know.
