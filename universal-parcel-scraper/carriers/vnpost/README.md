# VNPost

Vietnam Post (VNPost) parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

VNPost numbers domestic and international items alike with UPU S10 numbers ending `VN`, as
lookups archived from VNPost's tracking page show. Postal detection handles them, so VNPost
has no rule of its own.

## Links

VNPost's former tracking page put the number in the path after `/dinh-vi/buu-pham/key/`, and
the library reads it from such addresses. The current form asks for a captcha, so the library
builds no address.

## Why there is no adapter

The tracking form on `vnpost.vn/vi`, also served at `vietnampost.vn`, opens a Laravel session,
gets an image address from `/handle-captcha/refresh-captcha`, then sends the whole number and
the image's answer to `/postcode/thong-tin` as `post_code` and `captcha`. The image is a
four-character `mews` JPEG. The service checks the answer before it looks the number up:
without one it replies HTTP 422 "Vui lòng nhập captcha", and a wrong one gets "Captcha không
đúng hoặc đã hết hạn".

The international tracker on `ipostal.vnpost.vn` posts the numbers to `/api/v1/tra-cuu-buu-gui`
with a reCAPTCHA v2 checkbox token and, without one, answers "Vui lòng xác nhận captcha."

The My Vietnam Post Plus Android app (`vn.vnpost.myvnp`) and its web portal `my.vnpost.vn` are
for senders with an account. Their order search and item history need a signed-in session;
without one the app only looks up fees and post offices. VNPost therefore stays on universal
providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
