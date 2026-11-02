# Fixtures

The replies follow `Service.ashx`'s JSONP for one number, as the adapter asks it.

- `delivered.txt` is a parcel YDH flew from China to France and handed to a partner there,
  which delivered it after a failed attempt. Its scans are in the tracker's order, with the
  codes, row statuses and `time_zone` labels of a real reply: YDH's own scans in English or
  Chinese, the partner's relayed in French. One scan is listed twice, and another again without
  its code or English wording as a partner's copy, so the tests can show each is kept once. One
  uncoded scan has no English wording. The merchant's order
  reference, the partner's name and the signatory are present so the tests can show they are
  left out.
- `not-found.txt` is the answer for a number the tracker does not know.

Numbers, clocks, places and the merchant's details are invented.
