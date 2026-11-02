# Ahamove

Ahamove parcels use enabled universal providers. There is no dedicated adapter.

Ahamove (Công ty Cổ Phần Dịch Vụ Tức Thời), founded in Ho Chi Minh City in 2015, delivers orders on
demand within Vietnamese cities with partner drivers, by motorbike, van and truck, and offers
merchants an API. Its site is ahamove.com.

## Numbers

Its order ids are short codes of capital letters and digits; its developer documentation shows a
six-digit date followed by six letters or digits. Other carriers' rules read such shapes, and no
public order id is known, so there is no rule.

## Why there is no adapter

The tracking box posts the order id to a server action of its page, without a login or CAPTCHA, and
answers an unknown id as not found. The action's ids change with each release, so an adapter would
read them from the page first. No public order id has shown a known order's reply yet.

## Links

Tracking links carry the order id in the path after `/s/` on express.ahamove.com. Older share links
also carry the recipient's phone number and are not read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
