# Pošta Crne Gore

Pošta Crne Gore items use enabled universal providers. There is no dedicated adapter.

Montenegro's national post runs its own tracker, the Track & Trace page of its WebPostar
portal. The lookup needs a reCAPTCHA answer, so the page cannot be read without a browser.

## Numbers

The tracker accepts only the UPU S10 layout of two letters, nine digits and two letters.
Pošta Crne Gore's own items end in `ME`; numbers people searched on its website show
registered letters and parcels. Generic postal detection handles the layout, so no rule of
its own is needed. Inbound items keep the number of the post that sent them.

## Links

`webpostar.postacg.me/web_services/track_and_trace?tracking_number={number}` opens the tracker
with the number filled in: its script reads `tracking_number`. The lookup still waits for the
reCAPTCHA.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
