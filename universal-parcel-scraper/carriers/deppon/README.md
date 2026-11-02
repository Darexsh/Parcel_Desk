# Deppon

Reads Deppon's public tracking gateway through HTTP, including its image-slider verification.

Deppon (德邦) is a Chinese express and freight carrier, now part of JD Logistics. Its tracker
also follows its parcels to Taiwan.

## Retrieval

The [official tracker](https://www.deppon.com/orderTrack) gets a `blockPuzzle` from
`/gwapi/messageService/eco/message/captcha/getCaptchaAction`. The adapter matches the
transparent tile's texture to its slot, submits the native pixel offset to `checkCaptchaAction`
in the page's AES envelope and requires the server's accepted verification before tracking.
Uncertain matches and refused puzzles remain challenges. Each lookup owns its challenge and cookies.

It then posts one whole waybill to `/gwapi/trackService/eco/track/queryNewTrack` with the
single-use verification. The returned `billNo` must match, and `tracks` supplies the history.
Operation types stage known scans; unknown types do not inherit the page's generic transit icon.
Clocks without offsets stay local. Recipient fields and scan contact suffixes are omitted.
Transport diagnostics retain no verification material.

## Limitations

The request builder accepts a whole waybill without establishing ownership from its shape.
There is no number-only detection or cheap recognition, and no account is used. Changed
puzzle geometry or weak texture can prevent a solve; enabled universal providers remain the fallback.

## Testing

`npm run test:carriers:live -- carriers/deppon`. Set `DEPPON_TRACKING_NUMBER` for a known
shipment and `DEPPON_UNKNOWN_NUMBER` for an unknown waybill.
