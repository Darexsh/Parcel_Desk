# LEX Indonesia

LEX Indonesia, run by PT Lastana Express Indonesia in Jakarta, is the Lazada marketplace's delivery
network in Indonesia, founded with Lazada in 2012. Its site is lex.co.id.
[LEX Malaysia](../lex-my/README.md) shares its client; [LEX Vietnam](../lex-vn/README.md) is a separate
entry.

## How it works

1. `direct`: `POST lex.co.id/api/search_packages` with the number in `trackingNumbers`, the open JSON
   endpoint the tracking page posts to, without a login, cookie or CAPTCHA. The package it lists must
   name the number asked; an empty list is read as not found.
2. `retry`: the same read once more after a request fails to reach the site or hangs. The first attempt
   gets half of the budget.

Recognition asks the same search: a listed package says LEX holds the number.

## Notes

- The search gives the package's current status key alone, with no scan, time or place, so the result
  is marked `summary_only` and enabled universal providers are still asked for the history. The page's
  history endpoint, `get_package_history`, lists scans only with the last four digits of the
  recipient's phone number, which the adapter does not have.
- The status keys and the titles the page shows for them come from the page's script and are mapped
  by key in [statuses.json](statuses.json). Several titles are shared by keys of different stages, so
  a title alone stages nothing. A few keys say a driver is sought or assigned without saying for which
  leg, and stay without a stage.
- The search finds a number only with the hyphen after LXAD, which detection removes; the adapter puts
  it back. The package code and the first and last mile networks are not kept.
- [lex.ts](lex.ts) is the client of Lazada's LEX platform; each site sets its host, its numbers and its
  clock.

## Numbers

Its waybills are LXAD, a hyphen and ten digits. Buyers' and sellers' complaint letters on a consumer
site show them, from different writers over several years, so `lex-id-1` suggests LEX Indonesia at
high confidence. The oldest public numbers are no longer listed.

## Links

The tracking page reads numbers as `references` from its address, but finds one only with the hyphen
after LXAD, which detection removes, so there are no tracking links.

## Testing

Set `LEX_ID_TRACKING_NUMBER` and `LEX_ID_UNKNOWN_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/lex-id`.
