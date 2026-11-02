# LEX Malaysia

LEX (Lazada Express) is the Lazada marketplace's delivery network in Malaysia. Its site is lex.com.my. Lazada
runs LEX in other countries on their own sites; this entry covers Malaysia only.

## How it works

1. `direct`: `POST lex.com.my/api/search_packages` with the number in `trackingNumbers`, without a login,
   cookie or CAPTCHA. The site runs on the platform [LEX Indonesia](../lex-id/README.md)'s does and
   shares its client: the package listed must name the number asked, an empty list is read as not
   found, and the result is the current status key alone, marked `summary_only`.
2. `retry`: the same read once more after a request fails to reach the site or hangs.

Recognition asks the same search.

## Notes

- The status keys and titles are the platform's; [statuses.json](statuses.json) repeats LEX Indonesia's
  map, which the status map reads.
- The search has been seen behind a slider CAPTCHA, which is read as a challenge, not as a missing
  parcel. The history needs the last digits of the recipient's phone number.

## Numbers

Its numbers are `TMYLE` and nine digits, which `lex-my-1` suggests at low confidence; the only public
example is an archived lookup on its own tracker, which the search still lists. Parcels it delivers for
other networks keep their numbers.

## Links

The tracking page opens numbers from its `references` parameter.

## Testing

Set `LEX_MY_TRACKING_NUMBER` and `LEX_MY_UNKNOWN_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/lex-my`.
