# Singapore Post

The adapter uses the tracking site's anonymous JSON event endpoint. The site
executes reCAPTCHA before submitting its form, but its event request contains
only the tracking number. No browser session or account is needed for this
endpoint.

Mail scans supply offsets; Speedpost scans can omit them. The adapter keeps
offset-free scans as `local_time`, retains the portal's newest-first sequence,
and leaves `last_update` empty when the latest scan has no verified instant.
Empty history for an existing item is inconclusive; only the explicit
identity-bound missing-item response means not found. For Speedpost items that
response carries a single row of dashes, whose status can be empty. A delivery
scan's time is the result's `delivered_at`.

## Numbers

Detection names Singapore Post for the UPU S10 form ending in SG when its check digit passes.
Parcels from China that Singapore Post delivers can also carry `CNSGS` and ten digits, which its
tracker answers. No public sample shows that layout, so a low-confidence rule offers Singapore
Post for it. The adapter has no recognition step, so recognition does not ask it. The samples
and their sources are in [`numbers.json`](numbers.json).

Run `npm run test:carriers:live -- carriers/singapore-post`.
Set `SINGAPORE_POST_TRACKING_NUMBER` outside the repository for a real parcel.
