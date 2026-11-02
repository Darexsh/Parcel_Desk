# Stone3PL

Reads the anonymous lookup behind Stone3PL's public tracking page, including the
origin and destination histories and the onward tracking number.

## How it works

1. `direct`: posts one form-encoded number to
   `https://stone3pl.com/?route=services/get_track/track&is_debug=`, with
   `data[0][number]` and `data[0][i]=0`, as the page does. No account, cookie,
   API key, browser or refresh call is needed.
2. `retry`: repeats only a network failure or timeout, within the caller's budget.

The reply's `all_data` must bind the whole requested identifier through `number`,
`true_track_number` or `tracking_number`. Missing or ambiguous matches are
inconclusive, not not-found. Unknown numbers are echoed with `status: 1`, an
observation-time `track_date`, no scans and `front_status: 0`; only that last
bucket establishes no information. An empty history without it is inconclusive.

## Notes

- The page displays `track_last` (destination) before `track_info` (origin).
  Both streams are kept, without exact duplicates. Before handoff, `track_last`
  can contain objects whose only field is `t_time`; those are milestone placeholders,
  not scans, even when a time is present.
- Scan dates use `t_time`. The formatted `day` and `time` can contain a 24-hour
  hour followed by `pm`, and `track_date` / `end_track_date` can be the time of
  the lookup, so none of them establishes an event instant or estimate.
- The feed provides no timezone. The adapter keeps scan times in `local_time`,
  destination scans included; `createTracker()` dates them on a deduced zone,
  as it does for every carrier with local clocks.
- The scan's wording establishes its milestone. Numeric status 1 also appears
  on electronic pre-advice. The site's overall pick-up, delivered and alert
  buckets are retained; when a headline has no corresponding scan, the answer
  is partial.
- `true_track_number` is the page's last-mile number. The carrier is a handoff
  hint only when the feed names a catalog carrier; the number or destination
  alone never chooses one. Countries and shipping service are retained.
- The observed `S` plus eighteen-digit layout is a low-confidence recognition
  candidate, not a carrier assignment. Other identifiers can be looked up when
  Stone3PL is chosen or its official tracking link is pasted. Recognition is
  restricted to that narrow layout rather than probing every generic courier number.

## Limitations

- No ETA or location is invented. Contact details and signer names are discarded.

## Testing

Offline fixtures are synthetic. Run `npm test -- carriers/stone3pl`.
Live tests read `STONE3PL_TRACKING_NUMBER` and optional
`STONE3PL_UNKNOWN_NUMBER` from the environment, outside Git:
`npm run test:carriers:live -- carriers/stone3pl`.
